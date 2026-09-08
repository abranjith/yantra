/**
 * `yantra resume <run-id>` — resumes a previously failed or paused workflow run.
 *
 * Walks the resume point via {@link loadResumePoint} so we can gate on
 * user-consent failure classes before launching Chrome; under `--json` the
 * consent gate refuses with a validation error (interactive only).
 *
 * @example
 *   yantra resume 20260511T091234Z-bank-statement-a7b3
 *   yantra resume 20260511T091234Z-bank-statement-a7b3 --json
 */

import { PiAgentProvider } from '@yantra/agent';
import {
  InteractiveConfirmationGateway,
  type EffectivePreferences,
  type Logger,
} from '@yantra/core';
import type { RunManifest } from '@yantra/core/workflow/replay';
import {
  LocalRunStore,
  exitCodeFor,
  loadResumePoint,
  requiresUserConsent,
} from '@yantra/core/workflow/replay';
import { Command } from 'commander';

import { addAgentOptions, resolveAgentInvocation, type AgentOptions } from '../agent-options.js';
import { openArtifact } from '../open-artifact.js';
import { loadEffectivePreferences } from '../preferences.js';
import {
  buildOrchestratorRuntime,
  makeStderrLogger,
  type OrchestratorSynthesisOptions,
} from '../runtime.js';
import { createSynthesisLlm } from '../synthesis-llm.js';

interface ResumeOptions extends AgentOptions {
  readonly json?: boolean;
  readonly debug?: boolean;
  readonly force?: boolean;
  readonly open?: boolean;
}

export function makeResumeCommand(): Command {
  const cmd = new Command('resume');

  addAgentOptions(cmd)
    .description('Resume a previously failed or paused workflow run')
    .argument('<run-id>', 'Run ID to resume (from the run directory name)')
    .option('--json', 'Emit JSON summary to stdout', false)
    .option('--debug', 'Emit verbose debug logging to stderr', false)
    .option('--open', 'open the generated brief.html in the default browser', false)
    .option(
      '--force',
      'Skip the user-consent check for scope-violation / ethics-refused failures',
      false,
    )
    .action(async (runId: string, options: ResumeOptions) => {
      const logger = makeStderrLogger(options.debug === true);
      logger.info({ runId }, 'yantra resume: starting');
      let closeRuntime = (): void => undefined;

      try {
        // Same consent policy as `run`: prompt only in an interactive TTY,
        // never under `--json` / unattended (plan §6).
        const interactive = process.stdin.isTTY === true && options.json !== true;

        // Read the resume point before building the runtime, so the runtime can
        // inherit the original run's synthesis strategy — a resumed run must not
        // silently change how its Brief is produced. `loadResumePoint` needs only
        // a run store, so this costs nothing extra.
        const point = await loadResumePoint(new LocalRunStore(), runId);

        const inherited = await synthesisForResume(
          point.manifest,
          logger,
          options,
          process.env,
          await loadEffectivePreferences(),
        );
        const runtime = await buildOrchestratorRuntime({
          logger,
          confirmationGateway: interactive ? new InteractiveConfirmationGateway() : null,
          // Omitted, not set to undefined: an absent key disables the stage,
          // which is what a run that never synthesized should inherit.
          ...(inherited === undefined ? {} : { synthesis: inherited }),
        });
        const { orchestrator } = runtime;
        closeRuntime = runtime.close;

        if (options.force !== true && requiresUserConsent(point.manifest.failureClass)) {
          if (options.json === true) {
            process.stderr.write(
              `Resume of run ${runId} requires interactive consent (failure class: ${point.manifest.failureClass}). Re-run without --json or pass --force.\n`,
            );
            closeRuntime();
            process.exit(4);
          }
          process.stderr.write(
            `\nThis run was stopped due to "${point.manifest.failureClass}".\n` +
              `Resume only if you intended to allow this workflow to access that resource.\n` +
              `Pass --force to bypass this check.\n`,
          );
          closeRuntime();
          process.exit(4);
        }

        const outcome = await orchestrator.resume(runId);
        if (options.open === true && outcome.kind === 'success' && outcome.brief) {
          openArtifact(outcome.brief.htmlPath);
        }

        if (options.json === true) {
          process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
        } else {
          const icon = outcome.kind === 'success' ? '✓' : outcome.kind === 'aborted' ? '⤺' : '✗';
          process.stdout.write(`${icon} Resume ${outcome.runId}: ${outcome.kind}\n`);
        }

        closeRuntime();
        process.exit(exitCodeFor(outcome));
      } catch (err) {
        closeRuntime();
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        if (options.debug === true && err instanceof Error && err.stack !== undefined) {
          process.stderr.write(`${err.stack}\n`);
        }
        process.exit(1);
      }
    });

  return cmd;
}

/**
 * Rebuilds the original run's Synthesize-stage wiring from its manifest.
 *
 * A resumed run must produce its Brief the same way the first attempt did — a
 * run that started deterministic must not acquire a model on resume, and a run
 * that used one must not silently downgrade to a plainer document.
 *
 * `fallbackUsed` is read as *intent*, not outcome: a run that reached for a
 * model and had to settle for the deterministic Brief still wanted the model, so
 * the resume offers it one again. Only a run that was deterministic by decision
 * — the workflow never asked, or `--no-llm` vetoed it — resumes model-free.
 *
 * `manifest.synthesis` is absent when the first attempt never reached the stage
 * (it failed before completing, or the workflow declares no `synthesis:` block).
 * That returns `undefined`, which disables the stage — the resumed run then
 * decides for itself once it completes, exactly as a fresh run would.
 *
 * @param manifest - The original run's manifest.
 * @param logger - Structured logger for the synthesizer.
 * @returns The wiring, or undefined to leave the stage disabled.
 */
export async function synthesisForResume(
  manifest: RunManifest,
  logger: Logger,
  options: AgentOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  prefs: EffectivePreferences = new Map(),
): Promise<OrchestratorSynthesisOptions | undefined> {
  const record = manifest.synthesis;
  if (record === undefined) return undefined;
  if (record.strategy === 'deterministic' && !record.fallbackUsed) {
    return { llm: null, noLlm: true };
  }

  // The manifest records the strategy, not the model, so the model resolves the
  // documented way (flag absent here → environment → pinned default).
  const invocation = await resolveAgentInvocation('resume', options, env, prefs);
  if (invocation.mode === 'no-llm') return { llm: null, noLlm: true };
  return {
    noLlm: false,
    llm: ({ runId, runDir }) =>
      createSynthesisLlm({
        provider: new PiAgentProvider(),
        model: invocation.model,
        auth: invocation.auth,
        runId,
        runDir,
        cwd: process.cwd(),
        logger,
      }),
  };
}
