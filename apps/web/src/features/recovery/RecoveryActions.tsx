/**
 * Resume and Run again (FEAT-067 TASK-014), driven by `read.run_recovery`.
 *
 * - **Resume** shows only when the core rule says the run can resume. After a
 *   scope violation or ethics refusal it asks for an explicit acknowledgement
 *   first, which adds `--force` (shown in the CLI twin). When the run cannot
 *   resume, the reason sits on Run again as a tooltip, never as a disabled
 *   Resume.
 * - **Run again** starts the prior command with *Current settings* (the flags
 *   the user set, everything else re-resolved now) or *Prior settings* (every
 *   recorded setting pinned). The settings that differ are listed side by
 *   side. A rebuilt command is labelled "Reconstructed" or "Goal only".
 * - When the prior run filled, clicked or could submit, a warning lists what
 *   it did before anything starts; Cancel is the default.
 * - "Edit before running" opens the composer prefilled.
 */

import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink, useNavigate } from '@tanstack/react-router';
import type { EffectiveOptions, RunRecoveryAssessment } from '@yantra/protocol';
import {
  Button,
  Checkbox,
  Dialog,
  DialogTrigger,
  Select,
  Tooltip,
  TooltipTrigger,
} from '@yantra/ui';
import { useState, type Key, type ReactNode } from 'react';

import { useRpc } from '../../host/app-rpc.js';
import { InvocationTwin } from '../cockpit/cli-twin.js';
import {
  buildComposerModel,
  toInvocation,
  valuesFromArgv,
  type ComposerModel,
  type ComposerPath,
} from '../composer/composer-model.js';
import { useMissionContext } from '../composer/Composer.js';
import { SubmitRefusedError, submitInvocation } from '../composer/submit.js';

const COMPOSER_PATHS: ReadonlySet<string> = new Set(['ask', 'research', 'do', 'run', 'resume']);

/** Which recorded settings a Run again uses. */
export type RunAgainSettings = 'current' | 'prior';

/** What a finished run can do next. */
export function useRunRecovery(runId: string, enabled = true) {
  const rpc = useRpc();
  return useQuery({
    queryKey: ['run-recovery', runId],
    enabled,
    queryFn: () => rpc.request<RunRecoveryAssessment>('read.run_recovery', { run_id: runId }),
    retry: false,
  });
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\');
}

/** The model a Run again submits, or null when the prior command cannot be rebuilt. */
export function runAgainModel(
  assessment: RunRecoveryAssessment,
  settings: RunAgainSettings,
  cwd: string,
): ComposerModel | null {
  const again = assessment.run_again;
  const path = again.path?.[0];
  if (path === undefined || again.path?.length !== 1 || !COMPOSER_PATHS.has(path)) return null;
  const argv = settings === 'prior' ? again.pinned_argv : again.argv;
  if (argv === null) return null;
  const values = valuesFromArgv(path as ComposerPath, argv, cwd);
  return values === null
    ? null
    : buildComposerModel({ path: path as ComposerPath, values, effective: null });
}

/** The model a Resume submits. */
export function resumeModel(runId: string, force: boolean): ComposerModel {
  return buildComposerModel({
    path: 'resume',
    values: { positional: runId, options: force ? { force: true } : {} },
    effective: null,
  });
}

/** The label of a rebuilt command's source. */
export function priorLabel(prior: RunRecoveryAssessment['run_again']['prior']): string | null {
  if (prior === 'reconstructed') return 'Reconstructed';
  if (prior === 'goal_only') return 'Goal only';
  return null;
}

/** Settings whose values differ between two effective resolutions. */
export function settingsDiff(
  prior: EffectiveOptions | undefined,
  current: EffectiveOptions | undefined,
): { readonly flag: string; readonly prior: string; readonly current: string }[] {
  if (prior === undefined || current === undefined) return [];
  const show = (value: unknown): string => (value === null ? 'not set' : JSON.stringify(value));
  const now = new Map(current.options.map((item) => [item.option, item]));
  return prior.options.flatMap((item) => {
    const latest = now.get(item.option);
    const same =
      latest !== undefined && JSON.stringify(latest.value) === JSON.stringify(item.value);
    return same
      ? []
      : [{ flag: item.flag, prior: show(item.value), current: show(latest?.value ?? null) }];
  });
}

function useEffectiveFor(path: string | null, argv: readonly string[] | null, cwd: string | null) {
  const rpc = useRpc();
  return useQuery({
    queryKey: ['effective-options', path, argv, cwd, 'recovery'],
    enabled: path !== null && argv !== null && cwd !== null,
    queryFn: () =>
      rpc.request<EffectiveOptions>('read.effective_options', { path: [path], argv, cwd }),
  });
}

/** Submits `model` and follows it; resolves with an error message, or null on success. */
function useSubmit() {
  const rpc = useRpc();
  const navigate = useNavigate();
  return async (
    model: ComposerModel,
    effective: EffectiveOptions | null,
    cwd: string,
  ): Promise<string | null> => {
    try {
      const { summary } = await submitInvocation(rpc, { model, effective, cwd });
      await navigate({
        to: '/mission/invocations/$invocationId',
        params: { invocationId: summary.invocation_id },
      });
      return null;
    } catch (caught) {
      if (caught instanceof SubmitRefusedError) {
        return [caught.message, caught.remediation].filter((part) => part !== undefined).join(' ');
      }
      return caught instanceof Error ? caught.message : 'Yantra could not start this.';
    }
  };
}

function ResumeAction({
  assessment,
  cwd,
}: {
  readonly assessment: RunRecoveryAssessment;
  readonly cwd: string;
}): ReactNode {
  const submit = useSubmit();
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resume = assessment.resume;
  if (!resume.available) return null;
  const consent = resume.requires_consent;
  const model = resumeModel(assessment.run_id, consent && acknowledged);
  const start = async (): Promise<void> => {
    setError(await submit(model, null, cwd));
  };
  if (!consent) {
    return (
      <div className="flex flex-col gap-1">
        <Button variant="primary" size="sm" onPress={() => void start()}>
          Resume
        </Button>
        {error === null ? null : (
          <p role="alert" className="text-signal-failed-ink">
            {error}
          </p>
        )}
      </div>
    );
  }
  return (
    <DialogTrigger>
      <Button variant="primary" size="sm">
        Resume…
      </Button>
      <Dialog title="Resume past the stop?" role="alertdialog">
        {({ close }) => (
          <>
            <p className="text-ink-2">
              This run stopped with{' '}
              <span className="type-engine">{resume.failure_class ?? 'a refusal'}</span>. Resuming
              it skips the consent check (<span className="type-engine">--force</span>).
            </p>
            <Checkbox isSelected={acknowledged} onChange={setAcknowledged}>
              I understand and want to resume anyway.
            </Checkbox>
            <InvocationTwin
              invocation={toInvocation(model, { invocationId: 'resume-preview', cwd })}
            />
            {error === null ? null : (
              <p role="alert" className="text-signal-failed-ink">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" autoFocus onPress={close}>
                Cancel
              </Button>
              <Button variant="primary" isDisabled={!acknowledged} onPress={() => void start()}>
                Resume
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </DialogTrigger>
  );
}

function RunAgainDialog({
  assessment,
  cwd,
}: {
  readonly assessment: RunRecoveryAssessment;
  readonly cwd: string;
}): ReactNode {
  const submit = useSubmit();
  const again = assessment.run_again;
  const pinnable = again.prior === 'receipt';
  const [settings, setSettings] = useState<RunAgainSettings>('current');
  const [error, setError] = useState<string | null>(null);
  const path = again.path?.[0] ?? null;
  const current = useEffectiveFor(path, again.argv, cwd);
  const prior = useEffectiveFor(path, pinnable ? again.pinned_argv : null, cwd);
  const differences = settingsDiff(prior.data, current.data);
  const model = runAgainModel(assessment, settings, cwd);
  const warn = again.effects !== 'none';
  const label = priorLabel(again.prior);

  return (
    <Dialog title="Run again?" role={warn ? 'alertdialog' : 'dialog'}>
      {({ close }) => (
        <>
          {label === null ? null : (
            <p className="text-ink-2">
              <span className="rounded-chip border border-rule px-1.5 py-0.5 text-caption">
                {label}
              </span>{' '}
              {again.prior === 'goal_only'
                ? 'Only the goal was recorded; the run starts with today’s settings.'
                : 'The command was rebuilt from the run’s records; its settings were not recorded.'}
            </p>
          )}
          {pinnable ? (
            <Select
              label="Settings"
              options={[
                { id: 'current', label: 'Current settings' },
                { id: 'prior', label: 'Prior settings' },
              ]}
              selectedKey={settings}
              onSelectionChange={(key: Key | null) => {
                if (key === 'current' || key === 'prior') setSettings(key);
              }}
            />
          ) : null}
          {pinnable && differences.length > 0 ? (
            <table className="text-ink" data-part="settings-diff">
              <caption className="type-label pb-1 text-start text-ink-2">
                Settings that differ
              </caption>
              <thead>
                <tr>
                  <th className="pr-4 text-start type-label text-ink-2">Option</th>
                  <th className="pr-4 text-start type-label text-ink-2">Prior</th>
                  <th className="text-start type-label text-ink-2">Now</th>
                </tr>
              </thead>
              <tbody>
                {differences.map((row) => (
                  <tr key={row.flag}>
                    <td className="type-engine pr-4">{row.flag}</td>
                    <td className="type-engine pr-4">{row.prior}</td>
                    <td className="type-engine">{row.current}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {warn ? (
            <div
              role="note"
              className="flex flex-col gap-1 text-signal-partial-ink"
              data-part="effects-warning"
            >
              <p className="font-semibold">
                {again.effects === 'verified'
                  ? 'The previous run changed things on websites.'
                  : 'The previous run may have changed things on websites.'}
              </p>
              <ul className="list-disc pl-5">
                {again.effect_reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <p>Running it again may do the same again.</p>
            </div>
          ) : null}
          {model === null ? null : (
            <InvocationTwin
              invocation={toInvocation(model, { invocationId: 'run-again-preview', cwd })}
            />
          )}
          {error === null ? null : (
            <p role="alert" className="text-signal-failed-ink">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" autoFocus onPress={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              isDisabled={model === null}
              onPress={() => {
                if (model === null) return;
                void submit(
                  model,
                  settings === 'current' ? (current.data ?? null) : (prior.data ?? null),
                  cwd,
                ).then(setError);
              }}
            >
              Run again
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

export interface RecoveryActionsProps {
  readonly runId: string;
  readonly className?: string;
}

/** See the module comment. */
export function RecoveryActions({ runId, className }: RecoveryActionsProps): ReactNode {
  const recovery = useRunRecovery(runId);
  const context = useMissionContext();
  const assessment = recovery.data;
  if (assessment === undefined) return null;
  const recordedCwd = assessment.run_again.cwd;
  const cwd =
    recordedCwd !== null && isAbsolute(recordedCwd) ? recordedCwd : (context.data?.home ?? null);
  if (cwd === null) return null;
  const canRunAgain = runAgainModel(assessment, 'current', cwd) !== null;
  const resume = assessment.resume;
  const runAgain = (
    <DialogTrigger>
      <Button
        size="sm"
        variant={resume.available ? 'secondary' : 'primary'}
        isDisabled={!canRunAgain}
      >
        Run again…
      </Button>
      <RunAgainDialog assessment={assessment} cwd={cwd} />
    </DialogTrigger>
  );
  return (
    <div className={className} data-part="recovery-actions">
      <div className="flex flex-wrap items-center gap-2">
        <ResumeAction assessment={assessment} cwd={cwd} />
        {resume.available ? (
          runAgain
        ) : (
          <TooltipTrigger>
            {runAgain}
            <Tooltip>{resume.reason}</Tooltip>
          </TooltipTrigger>
        )}
        {canRunAgain ? (
          <RouterLink
            to="/mission"
            search={{ from: runId, settings: 'current' }}
            className="text-accent-ink underline underline-offset-2"
          >
            Edit before running
          </RouterLink>
        ) : null}
      </div>
      {resume.available ? null : <p className="sr-only">Resume: {resume.reason}</p>}
    </div>
  );
}
