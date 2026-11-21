import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { DoctorResult, InvocationState, InvocationSummary } from '@yantra/protocol';
import { createInvocationId } from '@yantra/protocol/commands';
import { Button, HealthCheck } from '@yantra/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { useRpc } from '../../host/app-rpc.js';

import { AgentSmokePanel } from './agent-smoke-panel.js';
import { HostEnvironmentPanel } from './host-environment.js';
import { PossibleOrphansPanel } from './possible-orphans.js';
import {
  REMEDIATION_ROUTE_PATHS,
  resolveRemediations,
  type RemediationAction,
} from './remediations.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isTerminalState(state: InvocationState): boolean {
  return (
    state === 'finished' ||
    state === 'discarded' ||
    state === 'never_started' ||
    state === 'needs_review'
  );
}

function invokeButtonLabel(defaultLabel: string, state: InvocationState | null): string {
  if (state === null) return defaultLabel;
  switch (state) {
    case 'queued':
    case 'reserved':
      return 'Queued…';
    case 'spawning':
    case 'claimed':
      return 'Starting…';
    case 'running':
      return 'Running…';
    case 'start_unknown':
      return 'Checking…';
    default:
      return defaultLabel;
  }
}

interface ActiveRemediationRun {
  readonly remediationId: string;
  readonly summary: InvocationSummary;
}

/**
 * Health (`/health`, FEAT-071 TASK-006/TASK-007): renders every `yantra doctor`
 * check from an in-process `read.doctor` call, browser and search provenance,
 * and engineered remediation actions from `REMEDIATION_CATALOG`.
 */
export function HealthSurface(): ReactNode {
  const rpc = useRpc();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeRun, setActiveRun] = useState<ActiveRemediationRun | null>(null);
  const [invokeError, setInvokeError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['health', 'doctor'],
    queryFn: () => rpc.request<DoctorResult>('read.doctor', { refresh: false }),
  });

  const rerun = useMutation({
    mutationFn: () => rpc.request<DoctorResult>('read.doctor', { refresh: true }),
    onSuccess: (fresh) => {
      queryClient.setQueryData(['health', 'doctor'], fresh);
    },
  });

  const invokeRemediation = useMutation({
    mutationFn: async ({
      remediationId,
      path,
      argv,
    }: {
      readonly remediationId: string;
      readonly path: readonly string[];
      readonly argv: readonly string[];
    }) => {
      setInvokeError(null);
      const summary = await rpc.request<InvocationSummary>('command.invoke', {
        invocation: {
          invocation_id: createInvocationId(),
          path: [...path],
          argv: [...argv],
          cwd: '/',
        },
        displayed_effective: { settings: [], content: [] },
      });
      return { remediationId, summary };
    },
    onSuccess: ({ remediationId, summary }) => {
      if (isTerminalState(summary.state)) {
        setActiveRun(null);
        rerun.mutate();
        return;
      }
      setActiveRun({ remediationId, summary });
    },
    onError: (err) => {
      setActiveRun(null);
      setInvokeError(err instanceof Error ? err.message : 'Failed to run remediation.');
    },
  });

  const activeInvocationId = activeRun?.summary.invocation_id ?? null;

  useEffect(() => {
    if (activeInvocationId === null) return undefined;

    const finishAndRefresh = (): void => {
      setActiveRun(null);
      rerun.mutate();
    };

    const offResult = rpc.on('invocation.result', (params) => {
      if (params.invocation_id === activeInvocationId) {
        finishAndRefresh();
      }
    });

    const offChanged = rpc.on('invocation.changed', () => {
      void rpc
        .request<InvocationSummary>('read.invocation', { invocation_id: activeInvocationId })
        .then((fresh) => {
          if (isTerminalState(fresh.state)) {
            finishAndRefresh();
          } else {
            setActiveRun((prev) =>
              prev?.summary.invocation_id === activeInvocationId
                ? { ...prev, summary: fresh }
                : prev,
            );
          }
        })
        .catch(() => {
          // Best-effort refresh; invocation.result will still trigger completion.
        });
    });

    return () => {
      offResult();
      offChanged();
    };
  }, [rpc, activeInvocationId, rerun]);

  const data = query.data;
  const error = query.error ?? rerun.error;

  const handleAction = (remediationId: string, action: RemediationAction): void => {
    if (action.kind === 'invoke') {
      invokeRemediation.mutate({
        remediationId,
        path: action.path,
        argv: action.argv,
      });
      return;
    }
    if (action.kind === 'navigate') {
      void navigate({
        to: REMEDIATION_ROUTE_PATHS[action.route],
        search: action.params,
      });
    }
  };

  return (
    <section className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-display font-semibold text-ink">Health</h1>
          <p className="mt-1 text-caption text-ink-2">
            Offline environment diagnostics from <span className="type-engine">yantra doctor</span>.
          </p>
        </div>
        <Button
          variant="secondary"
          isDisabled={query.isLoading || rerun.isPending}
          onPress={() => {
            rerun.mutate();
          }}
        >
          {rerun.isPending ? 'Re-running…' : 'Re-run checks'}
        </Button>
      </header>

      {error !== null && error !== undefined ? (
        <p
          role="alert"
          className="rounded-card border border-rule bg-surface p-4 text-caption text-signal-failed-ink"
        >
          {error instanceof Error ? error.message : 'Failed to load health diagnostics.'}
        </p>
      ) : null}

      {invokeError !== null ? (
        <p
          role="alert"
          className="rounded-card border border-rule bg-surface p-4 text-caption text-signal-failed-ink"
        >
          {invokeError}
        </p>
      ) : null}

      {query.isLoading ? <p className="text-caption text-ink-2">Running diagnostics…</p> : null}

      {data !== undefined ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-rule bg-surface p-4 text-caption">
            <div className="flex items-center gap-2">
              <span className="text-ink-2">Overall:</span>
              <span className="font-semibold text-ink" data-testid="health-overall">
                {data.overall}
              </span>
            </div>
            <div className="flex flex-wrap gap-4 text-micro text-ink-2">
              <span>
                Platform: <span className="type-engine text-ink">{data.platform}</span>
              </span>
              <span>
                Node: <span className="type-engine text-ink">{data.nodeVersion}</span>
              </span>
              <span>
                Protocol: <span className="type-engine text-ink">{data.version}</span>
              </span>
            </div>
          </div>

          {data.browser !== undefined ? (
            <section
              aria-labelledby="health-browser-heading"
              className="flex flex-col gap-2 rounded-card border border-rule bg-surface p-4 text-caption"
            >
              <h2 id="health-browser-heading" className="font-medium text-ink">
                Browser provenance
              </h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-micro">
                <dt className="text-ink-2">Selection</dt>
                <dd className="type-engine text-ink">
                  {data.browser.source} ({data.browser.origin}
                  {data.browser.ownership !== undefined ? `, ${data.browser.ownership}` : ''})
                </dd>
                {data.browser.executablePath !== undefined ? (
                  <>
                    <dt className="text-ink-2">Executable</dt>
                    <dd className="type-engine break-all text-ink">
                      {data.browser.executablePath}
                    </dd>
                  </>
                ) : null}
                {data.browser.browserVersion !== undefined ? (
                  <>
                    <dt className="text-ink-2">Browser version</dt>
                    <dd className="type-engine text-ink">{data.browser.browserVersion}</dd>
                  </>
                ) : null}
                <dt className="text-ink-2">Compatibility</dt>
                <dd className="type-engine text-ink">{data.browser.compatibility}</dd>
                <dt className="text-ink-2">Managed build</dt>
                <dd className="type-engine text-ink">
                  {data.browser.managedBuild ?? 'absent'} ({data.browser.managedRoot})
                </dd>
                <dt className="text-ink-2">Superseded builds</dt>
                <dd className="type-engine text-ink">
                  {String(data.browser.orphanCount)} ({formatBytes(data.browser.reclaimableBytes)}{' '}
                  reclaimable)
                </dd>
              </dl>
              {data.browser.remediation !== undefined ? (
                <p className="mt-1 text-micro text-ink-2">{data.browser.remediation}</p>
              ) : null}
            </section>
          ) : null}

          {data.search !== undefined ? (
            <section
              aria-labelledby="health-search-heading"
              className="flex flex-col gap-2 rounded-card border border-rule bg-surface p-4 text-caption"
            >
              <h2 id="health-search-heading" className="font-medium text-ink">
                Search provenance
              </h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-micro">
                <dt className="text-ink-2">Provider</dt>
                <dd className="type-engine text-ink">{data.search.provider}</dd>
                <dt className="text-ink-2">Kind</dt>
                <dd className="type-engine text-ink">{data.search.kind}</dd>
                <dt className="text-ink-2">Selected via</dt>
                <dd className="type-engine text-ink">{data.search.via}</dd>
              </dl>
            </section>
          ) : null}

          <AgentSmokePanel />

          <HostEnvironmentPanel />

          <PossibleOrphansPanel />

          <div className="flex flex-col gap-3" data-testid="health-checks">
            {data.checks.map((check) => {
              const remediations = resolveRemediations(check);
              const actionable = remediations.filter((item) => item.action.kind !== 'text');
              const textNotes = remediations
                .map((item) => (item.action.kind === 'text' ? item.action.note : undefined))
                .filter((note): note is string => note !== undefined);
              const combinedRemediation = [check.remediation, ...textNotes]
                .filter((part): part is string => part !== undefined && part.length > 0)
                .join(' ');

              const remediationSlot =
                actionable.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {actionable.map((item) => {
                      const isThisActive = activeRun?.remediationId === item.id;
                      const isThisInvoking =
                        invokeRemediation.isPending &&
                        invokeRemediation.variables?.remediationId === item.id;
                      const disabled =
                        item.action.kind === 'invoke' &&
                        (isThisActive || isThisInvoking || rerun.isPending);
                      const label =
                        item.action.kind === 'invoke'
                          ? invokeButtonLabel(
                              item.label,
                              isThisActive
                                ? activeRun.summary.state
                                : isThisInvoking
                                  ? 'spawning'
                                  : null,
                            )
                          : item.label;

                      return (
                        <Button
                          key={item.id}
                          variant="secondary"
                          isDisabled={disabled}
                          onPress={() => {
                            handleAction(item.id, item.action);
                          }}
                        >
                          {label}
                        </Button>
                      );
                    })}
                  </div>
                ) : undefined;

              return (
                <HealthCheck
                  key={check.id}
                  id={check.id}
                  title={check.title}
                  status={check.status}
                  summary={check.summary}
                  {...(check.details === undefined ? {} : { details: check.details })}
                  {...(combinedRemediation.length > 0 ? { remediation: combinedRemediation } : {})}
                  {...(remediationSlot === undefined ? {} : { remediationSlot })}
                />
              );
            })}
          </div>
        </>
      ) : null}
    </section>
  );
}
