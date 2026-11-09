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
  ResourceBusyError,
  RunEventLogError,
  type RunEventStream,
  BrowserInstallOfferDeclinedError,
  BrowserManagedInstallError,
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
import { COMMAND_REGISTRY } from '@yantra/protocol';
import { type Command } from 'commander';

import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import { resolveAgentInvocation, type AgentOptions } from '../agent-options.js';
import {
  resolveBrowserSelectionOverride,
  type BrowserSelectionOptions,
} from '../browser-options.js';
import type { CommandContext, CommandResult, ExitCode } from '../context/command-context.js';
import { replayContent } from '../context/replay-content.js';
import type { ReplayRuntimeDependencies } from '../context/replay-runtime.js';
import { resourceOptions } from '../context/resource-options.js';
import { draftRunReceipt } from '../context/run-receipt.js';
import { createRegisteredCommand } from '../registry/build-command-tree.js';
import { handler, type Handler, type HandlerArgs } from '../registry/handler.js';
import { createLiveRunEvents, finishRunEvents, liveRenderOpts } from '../run-event-output.js';
import {
  buildOrchestratorRuntime,
  makeStderrLogger,
  type OrchestratorSynthesisOptions,
} from '../runtime.js';
import { createSynthesisLlm } from '../synthesis-llm.js';

interface ResumeOptions extends AgentOptions, BrowserSelectionOptions {
  readonly json?: boolean;
  readonly debug?: boolean;
  readonly force?: boolean;
  readonly open?: boolean;
}

export function makeResumeCommand(): Command {
  return createRegisteredCommand('resume', { resume: handler(resumeHandler) });
}

export function makeResumeHandler(
  dependencies?: ReplayRuntimeDependencies,
  context?: CommandContext,
): Handler {
  return handler((args: HandlerArgs, options: ResumeOptions, command: Command) =>
    resumeHandler(args, options, command, context, dependencies),
  );
}

/** `yantra resume <run-id>`: bound to the `resume` registry entry. */
export async function resumeHandler(
  args: HandlerArgs,
  options: ResumeOptions,
  command?: Command,
  context: CommandContext = createTerminalContext(),
  dependencies: ReplayRuntimeDependencies = {},
): Promise<CommandResult> {
  const [runId] = args as readonly [string];
  const entry = COMMAND_REGISTRY.commands.find((e) => e.id === 'resume');
  if (entry?.kind === 'leaf' && command) context.settings.bind(entry, command);

  const logger = makeStderrLogger(options.debug === true, context.output.stderr);
  logger.info({ runId }, 'yantra resume: starting');
  let closeRuntime = (): void => undefined;
  let runEvents: RunEventStream | null = null;

  // Resolved before any run state is touched: a conflicting `--browser`
  // pair is a validation failure, not a resume that half-started.
  let browserSelection;
  try {
    browserSelection = resolveBrowserSelectionOverride(options);
  } catch (err) {
    context.output.stderr.write(`${err instanceof Error ? err.message : String(err)}
`);
    return { exitCode: 1 as ExitCode };
  }

  try {
    // Same consent policy as `run`: prompt only in an interactive TTY,
    // never under `--json` / unattended (plan §6).
    const interactive = context.isInteractive({ json: options.json === true });

    // Read the resume point before building the runtime, so the runtime can
    // inherit the original run's synthesis strategy — a resumed run must not
    // silently change how its Brief is produced. `loadResumePoint` needs only
    // a run store, so this costs nothing extra.
    const point = await (dependencies.loadResumePoint ?? loadResumePoint)(
      new LocalRunStore(),
      runId,
    );

    const inherited = await synthesisForResume(
      point.manifest,
      logger,
      options,
      context.settings.env(),
      await context.settings.preferences(),
      context.cwd,
    );
    const runtime = await (dependencies.build ?? buildOrchestratorRuntime)({
      logger,
      confirmationGateway: context.gateways.confirmation(interactive),
      browser: {
        resourceLockOptions: resourceOptions(context, 'resume'),
        installOfferGateway: context.gateways.installOffer(interactive),
        ...(browserSelection === undefined ? {} : { selection: browserSelection }),
      },
      // Omitted, not set to undefined: an absent key disables the stage,
      // which is what a run that never synthesized should inherit.
      ...(inherited === undefined ? {} : { synthesis: inherited }),
    });
    const { orchestrator } = runtime;
    closeRuntime = runtime.close;

    if (options.force !== true && requiresUserConsent(point.manifest.failureClass)) {
      if (options.json === true) {
        context.output.stderr.write(
          `Resume of run ${runId} requires interactive consent (failure class: ${point.manifest.failureClass}). Re-run without --json or pass --force.\n`,
        );
        closeRuntime();
        return { exitCode: 4 as ExitCode };
      }
      context.output.stderr.write(
        `\nThis run was stopped due to "${point.manifest.failureClass}".\n` +
          `Resume only if you intended to allow this workflow to access that resource.\n` +
          `Pass --force to bypass this check.\n`,
      );
      closeRuntime();
      return { exitCode: 4 as ExitCode };
    }

    const receipt = await draftRunReceipt(context, ['resume'], {
      ...(browserSelection === undefined ? {} : { browser: browserSelection }),
      content: await replayContent(point.manifest.workflowName),
    });
    // FEAT-063: the resumed run continues its own run-events.jsonl.
    runEvents = createLiveRunEvents(liveRenderOpts(context, options.json === true));
    const outcome = await orchestrator.resume(runId, { receipt, runEvents });
    if (options.open === true && outcome.kind === 'success' && outcome.brief) {
      context.openExternal(outcome.brief.htmlPath);
    }

    if (options.json === true) {
      context.output.json(outcome, { indent: 2 });
    } else {
      const icon = outcome.kind === 'success' ? '✓' : outcome.kind === 'aborted' ? '⤺' : '✗';
      context.output.stdout.write(`${icon} Resume ${outcome.runId}: ${outcome.kind}\n`);
    }

    closeRuntime();
    const exitCode = exitCodeFor(outcome) as ExitCode;
    finishRunEvents(runEvents, exitCode);
    return { exitCode };
  } catch (err) {
    closeRuntime();
    if (err instanceof ResourceBusyError) {
      if (runEvents) finishRunEvents(runEvents, 3);
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    context.output.stderr.write(`Error: ${message}\n`);
    if (options.debug === true && err instanceof Error && err.stack !== undefined) {
      context.output.stderr.write(`${err.stack}\n`);
    }
    const exitCode = (
      err instanceof BrowserInstallOfferDeclinedError
        ? 4
        : err instanceof BrowserManagedInstallError || err instanceof RunEventLogError
          ? 3
          : 1
    ) as ExitCode;
    if (runEvents) finishRunEvents(runEvents, exitCode);
    return { exitCode };
  }
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
  env: NodeJS.ProcessEnv = {},
  prefs: EffectivePreferences = new Map(),
  cwd = '.',
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
        cwd,
        logger,
      }),
  };
}
