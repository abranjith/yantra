import { useMutation, useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from '@tanstack/react-router';
import type {
  CommandResultMessage,
  EffectiveOptions,
  EffectiveOptionView,
  InvocationState,
  InvocationSummary,
  MissionContext,
  ProviderReadiness,
} from '@yantra/protocol';
import {
  COMMAND_REGISTRY,
  conditionHolds,
  createInvocationId,
  expandOptions,
  findLeaf,
  isAppExemptOption,
  isKnownDeadOption,
  type InvocationFacts,
} from '@yantra/protocol/commands';
import { Button, linkStyles } from '@yantra/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  flagLabel,
  type ComposerField,
  type OptionValue,
} from '../../features/composer/composer-model.js';
import { FieldRenderer } from '../../features/composer/field-renderers.js';
import { displayedEffective } from '../../features/composer/submit.js';
import {
  DISPLAYED_WORDS,
  deriveDisplayedState,
  type DisplayedState,
} from '../../features/live/displayed-state.js';
import { useInvocation } from '../../features/live/use-invocation.js';
import { useRunSnapshot, useRunStream } from '../../features/live/use-run-stream.js';
import { useRpc } from '../../host/app-rpc.js';
import { useConnection } from '../../host/connection-store.js';

const MODEL_OPTION_FLAGS = new Set(['--provider', '--model', '--thinking', '--auth-secret']);
const MODELS_PATH = '/settings/models' as '/mission';

export interface DoctorSmokeEnvelope {
  readonly kind?: string;
  readonly outcome: 'passed' | 'failed' | 'aborted';
  readonly provider: string;
  readonly model: string;
  readonly runId?: string;
  readonly statusToolInvoked: boolean;
  readonly usage: {
    readonly turns: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly costUsd?: number;
  };
}

function isTerminalInvocation(state: InvocationState | undefined): boolean {
  return (
    state === 'finished' ||
    state === 'discarded' ||
    state === 'never_started' ||
    state === 'needs_review'
  );
}

function asSmokeEnvelope(envelope: unknown): DoctorSmokeEnvelope | null {
  if (typeof envelope !== 'object' || envelope === null) return null;
  const raw = envelope as Record<string, unknown>;
  const candidate =
    typeof raw.result === 'object' && raw.result !== null
      ? (raw.result as Record<string, unknown>)
      : raw;
  const outcome = candidate.outcome;
  if (outcome !== 'passed' && outcome !== 'failed' && outcome !== 'aborted') return null;
  if (typeof candidate.provider !== 'string' || typeof candidate.model !== 'string') return null;
  if (typeof candidate.statusToolInvoked !== 'boolean') return null;
  const usage = candidate.usage as Record<string, unknown> | undefined;
  if (typeof usage !== 'object' || usage === null || typeof usage.turns !== 'number') return null;
  return {
    ...(typeof candidate.kind === 'string' ? { kind: candidate.kind } : {}),
    outcome,
    provider: candidate.provider,
    model: candidate.model,
    ...(typeof candidate.runId === 'string' ? { runId: candidate.runId } : {}),
    statusToolInvoked: candidate.statusToolInvoked,
    usage: {
      turns: usage.turns,
      ...(typeof usage.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
      ...(typeof usage.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {}),
      ...(typeof usage.costUsd === 'number' ? { costUsd: usage.costUsd } : {}),
    },
  };
}

function buildSmokeArgv(
  optionValues: Readonly<Record<string, OptionValue>>,
  fields: readonly ComposerField[],
): string[] {
  const argv: string[] = ['--agent-smoke'];
  for (const field of fields) {
    const val = optionValues[field.optionName];
    if (typeof val === 'string' && val.trim() !== '') {
      argv.push(field.flag, val);
    }
  }
  return argv;
}

function SmokeStreamStatus({
  runId,
  invocation,
  stopping,
}: {
  readonly runId: string;
  readonly invocation: InvocationSummary | null;
  readonly stopping: boolean;
}): ReactNode {
  const stream = useRunStream(runId);
  const snapshot = useRunSnapshot(stream);
  const connection = useConnection();
  const displayed = deriveDisplayedState({
    invocation,
    connection,
    channel: snapshot.channel,
    cockpit: snapshot.cockpit,
    stopping,
  });
  return <SmokeDisplayedStateLine displayed={displayed} />;
}

function SmokePreRunStatus({
  invocation,
  stopping,
}: {
  readonly invocation: InvocationSummary | null;
  readonly stopping: boolean;
}): ReactNode {
  const connection = useConnection();
  const displayed = deriveDisplayedState({
    invocation,
    connection,
    channel: { state: 'connecting' },
    cockpit: null,
    stopping,
  });
  return <SmokeDisplayedStateLine displayed={displayed} />;
}

function SmokeDisplayedStateLine({ displayed }: { readonly displayed: DisplayedState }): ReactNode {
  return (
    <div
      data-testid="smoke-run-status"
      className="flex flex-wrap items-center gap-2 text-xs text-ink-2"
    >
      <span className="font-medium text-ink">{DISPLAYED_WORDS[displayed.kind]}</span>
      {displayed.position !== null ? (
        <span className="type-engine">(position {String(displayed.position)})</span>
      ) : null}
      {displayed.detail !== '' ? <span>{displayed.detail}</span> : null}
    </div>
  );
}

/**
 * Provider smoke test panel on Health (FEAT-071 TASK-008): runs
 * `doctor --agent-smoke` as a run-class worker with the registry's
 * model-selection options (`--provider`, `--model`, `--thinking`, `--auth-secret`).
 */
export function AgentSmokePanel(): ReactNode {
  const rpc = useRpc();
  const [optionValues, setOptionValues] = useState<Readonly<Record<string, OptionValue>>>({});
  const [invocationId, setInvocationId] = useState<string | null>(null);
  const [initialSummary, setInitialSummary] = useState<InvocationSummary | null>(null);
  const [stopping, setStopping] = useState(false);
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CommandResultMessage | null>(null);
  const [announcement, setAnnouncement] = useState<string>('');

  const missionContext = useQuery({
    queryKey: ['mission-context'],
    queryFn: () => rpc.request<MissionContext>('read.mission_context'),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const cwd = missionContext.data?.home ?? '/';

  const doctorEntry = useMemo(() => findLeaf(['doctor']), []);

  const rawArgv = useMemo(() => {
    if (doctorEntry === undefined) return ['--agent-smoke'];
    const specs = expandOptions(doctorEntry, COMMAND_REGISTRY.option_groups).filter((spec) =>
      MODEL_OPTION_FLAGS.has(spec.long),
    );
    const argv: string[] = ['--agent-smoke'];
    for (const spec of specs) {
      const val = optionValues[spec.attribute];
      if (typeof val === 'string' && val.trim() !== '') {
        argv.push(spec.long, val);
      }
    }
    return argv;
  }, [doctorEntry, optionValues]);

  const effective = useQuery({
    queryKey: ['health', 'smoke', 'effective-options', rawArgv, cwd],
    queryFn: () =>
      rpc.request<EffectiveOptions>('read.effective_options', {
        path: ['doctor'],
        argv: rawArgv,
        cwd,
      }),
    retry: false,
    placeholderData: (previous) => previous,
  });

  const readiness = useQuery({
    queryKey: ['health', 'smoke', 'provider-readiness', rawArgv, cwd],
    queryFn: () =>
      rpc.request<ProviderReadiness>('read.provider_readiness', {
        path: ['doctor'],
        argv: rawArgv,
        cwd,
      }),
    retry: false,
    placeholderData: (previous) => previous,
  });

  const fields = useMemo<readonly ComposerField[]>(() => {
    if (doctorEntry === undefined) return [];
    const mode = effective.data?.mode ?? 'llm';
    const optionsRecord: Record<string, unknown> = { agentSmoke: true };
    const explicit: readonly string[] = ['--agent-smoke'];
    for (const [k, v] of Object.entries(optionValues)) {
      optionsRecord[k] = v;
    }
    const facts: InvocationFacts = {
      options: optionsRecord,
      arguments: {},
      explicit,
      mode,
    };
    const effectiveByFlag = new Map<string, EffectiveOptionView>(
      (effective.data?.options ?? []).map((item) => [item.flag, item]),
    );
    return expandOptions(doctorEntry, COMMAND_REGISTRY.option_groups)
      .filter((spec) => MODEL_OPTION_FLAGS.has(spec.long))
      .filter((spec) => spec.input.kind !== 'secret-input')
      .filter((spec) => !isKnownDeadOption(doctorEntry.id, spec.long))
      .filter((spec) => !isAppExemptOption(spec.long))
      .filter((spec) => spec.applicability?.some((c) => !conditionHolds(c, facts)) !== true)
      .map((spec) => ({
        optionName: spec.attribute,
        flag: spec.long,
        inputKind: spec.input,
        label: flagLabel(spec.long),
        help: spec.description,
        isSwitch: false,
        repeatable: spec.repeatable === true,
        value: optionValues[spec.attribute],
        effective: effectiveByFlag.get(spec.long) ?? null,
        relations: [],
        danger: null,
      }));
  }, [doctorEntry, effective.data, optionValues]);

  const invocationQuery = useInvocation(invocationId);
  const invocation = invocationQuery.data ?? initialSummary;

  useEffect(() => {
    if (invocationId === null) return undefined;
    const offResult = rpc.on('invocation.result', (params) => {
      if (params.invocation_id !== invocationId) return;
      const resultOutcome = params.outcome as CommandResultMessage | undefined;
      if (resultOutcome === undefined) return;
      setOutcome(resultOutcome);
      setStopping(false);
      if (resultOutcome.type === 'result') {
        const parsed = asSmokeEnvelope(resultOutcome.envelope);
        setAnnouncement(
          parsed !== null
            ? `Provider smoke test ${parsed.outcome}.`
            : 'Provider smoke test finished.',
        );
      } else {
        setAnnouncement('Provider smoke test failed with error.');
      }
    });
    return () => {
      offResult();
    };
  }, [rpc, invocationId]);

  const startSmoke = useMutation({
    mutationFn: async () => {
      const id = createInvocationId();
      const argv = buildSmokeArgv(optionValues, fields);
      const summary = await rpc.request<InvocationSummary>('command.invoke', {
        invocation: {
          invocation_id: id,
          path: ['doctor'],
          argv,
          cwd,
        },
        displayed_effective: displayedEffective(effective.data ?? null),
      });
      return { id, summary };
    },
    onMutate: () => {
      setInvokeError(null);
      setOutcome(null);
      setStopping(false);
    },
    onSuccess: ({ id, summary }) => {
      setInvocationId(id);
      setInitialSummary(summary);
      setAnnouncement('Provider smoke test started.');
    },
    onError: (err) => {
      setInvokeError(err instanceof Error ? err.message : 'Failed to start provider smoke test.');
    },
  });

  const cancelSmoke = useMutation({
    mutationFn: async (id: string) => {
      setStopping(true);
      return rpc.request<InvocationSummary>('command.cancel', { invocation_id: id });
    },
    onError: (err) => {
      setStopping(false);
      setInvokeError(err instanceof Error ? err.message : 'Failed to stop provider smoke test.');
    },
  });

  const isDeterministic = effective.data?.mode === 'deterministic';
  const readinessBlocked = readiness.data !== undefined && !readiness.data.ready;
  const unavailable = isDeterministic || readinessBlocked;
  const isRunning =
    startSmoke.isPending ||
    (invocationId !== null && outcome === null && !isTerminalInvocation(invocation?.state));

  let unavailableReason: string | null = null;
  if (isDeterministic || readiness.data?.reason?.includes('LLM_PROVIDER=none')) {
    unavailableReason = '`doctor --agent-smoke` requires an LLM; unset LLM_PROVIDER=none.';
  } else if (readinessBlocked && readiness.data !== undefined) {
    const reasonText = readiness.data.reason ?? 'Provider is not ready.';
    unavailableReason =
      readiness.data.provider === ''
        ? `\`doctor --agent-smoke\` requires an LLM; ${reasonText}`
        : reasonText;
  }

  const smokeEnvelope =
    outcome !== null && outcome.type === 'result' ? asSmokeEnvelope(outcome.envelope) : null;
  const runId = invocation?.run_id ?? null;
  const resultRunId = smokeEnvelope?.runId ?? runId;

  return (
    <section
      aria-labelledby="health-smoke-heading"
      data-testid="agent-smoke-panel"
      className="flex flex-col gap-4 rounded-card border border-rule bg-surface p-4 text-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="health-smoke-heading" className="font-medium text-ink">
            Provider smoke test
          </h2>
          <p className="mt-1 text-xs text-ink-2">
            Runs a live round trip against the configured provider using{' '}
            <span className="type-engine">yantra doctor --agent-smoke</span>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isRunning && invocationId !== null ? (
            <Button
              variant="secondary"
              isDisabled={stopping || cancelSmoke.isPending}
              onPress={() => {
                cancelSmoke.mutate(invocationId);
              }}
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </Button>
          ) : null}
          <Button
            variant="primary"
            isDisabled={unavailable || isRunning}
            onPress={() => {
              startSmoke.mutate();
            }}
          >
            {isRunning ? 'Running…' : 'Run smoke test'}
          </Button>
        </div>
      </div>

      {unavailableReason !== null ? (
        <div
          role="note"
          data-testid="smoke-unavailable"
          className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-rule bg-sunken p-3 text-xs text-ink-2"
        >
          <span>{unavailableReason}</span>
          <RouterLink to={MODELS_PATH} className={linkStyles()}>
            Settings → Models
          </RouterLink>
        </div>
      ) : null}

      {fields.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((field) => (
            <FieldRenderer
              key={field.flag}
              field={field}
              onChange={(next) => {
                setOptionValues((prev) => {
                  const updated = { ...prev };
                  if (next === undefined) {
                    delete updated[field.optionName];
                  } else {
                    updated[field.optionName] = next;
                  }
                  return updated;
                });
              }}
            />
          ))}
        </div>
      ) : null}

      {invokeError !== null ? (
        <p role="alert" className="text-xs text-signal-failed-ink">
          {invokeError}
        </p>
      ) : null}

      {invocationId !== null && outcome === null ? (
        runId !== null ? (
          <SmokeStreamStatus runId={runId} invocation={invocation} stopping={stopping} />
        ) : (
          <SmokePreRunStatus invocation={invocation} stopping={stopping} />
        )
      ) : null}

      {outcome !== null && outcome.type === 'error' ? (
        <div
          data-testid="smoke-error-result"
          className="flex flex-col gap-1 rounded-control border border-rule bg-sunken p-3 text-xs"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="type-engine font-semibold text-signal-failed-ink">{outcome.code}</span>
            {outcome.exit_code === 3 ? (
              <span className="rounded-pill bg-surface px-2 py-0.5 text-ink-2">environment</span>
            ) : null}
          </div>
          <p className="text-ink">{outcome.message}</p>
          {outcome.remediation !== null ? (
            <p className="text-ink-2">{outcome.remediation}</p>
          ) : null}
        </div>
      ) : null}

      {smokeEnvelope !== null ? (
        <div
          data-testid="smoke-result"
          className="flex flex-col gap-2 rounded-control border border-rule bg-sunken p-3 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-ink-2">Outcome:</span>
              <span className="font-semibold text-ink" data-testid="smoke-outcome">
                {smokeEnvelope.outcome}
              </span>
            </div>
            {resultRunId !== null ? (
              <RouterLink
                to="/runs/$runId"
                params={{ runId: resultRunId }}
                className={linkStyles()}
              >
                Open run
              </RouterLink>
            ) : null}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
            <dt className="text-ink-2">Provider</dt>
            <dd className="type-engine text-ink">
              {smokeEnvelope.provider}/{smokeEnvelope.model}
            </dd>
            <dt className="text-ink-2">Turns</dt>
            <dd className="type-engine text-ink">{String(smokeEnvelope.usage.turns)}</dd>
            {smokeEnvelope.usage.inputTokens !== undefined ||
            smokeEnvelope.usage.outputTokens !== undefined ? (
              <>
                <dt className="text-ink-2">Usage</dt>
                <dd className="type-engine text-ink">
                  {smokeEnvelope.usage.inputTokens ?? 0} in /{' '}
                  {smokeEnvelope.usage.outputTokens ?? 0} out
                  {smokeEnvelope.usage.costUsd !== undefined
                    ? ` ($${smokeEnvelope.usage.costUsd.toFixed(4)})`
                    : ''}
                </dd>
              </>
            ) : null}
            <dt className="text-ink-2">statusToolInvoked</dt>
            <dd className="type-engine text-ink">{String(smokeEnvelope.statusToolInvoked)}</dd>
          </dl>
        </div>
      ) : null}

      <div role="status" aria-live="polite" data-testid="smoke-live-region" className="sr-only">
        {announcement}
      </div>
    </section>
  );
}
