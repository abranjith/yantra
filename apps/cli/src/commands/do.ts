/**
 * `yantra do "<goal>"` — the CLI shell around the agentic runtime.
 *
 * The command owns argument parsing, model/auth selection, connector rendering,
 * and exit-code mapping only. The reasoning/tool loop lives exclusively in
 * `runAgenticTask()` inside `@yantra/agent`.
 */

import { readFile } from 'node:fs/promises';

import {
  exitCodeForAgenticOutcome,
  resolveCommandTaskProfile,
  taskOutcomeOf,
  type runAgenticTask,
  type ActiveReportTemplate,
  type AgenticTaskOutcome,
  type PromotionResult,
} from '@yantra/agent';
import { UserInputMarkerError, type EffectivePreferences } from '@yantra/core';
import { COMMAND_REGISTRY, validateTemplatedReport } from '@yantra/protocol';
import { CommanderError, type Command } from 'commander';

import {
  createTerminalContext,
  type TerminalOptions,
} from '../adapters/terminal/terminal-adapter.js';
import { resolveAgentInvocation, type AgentOptions } from '../agent-options.js';
import {
  resolveBrowserSelectionOverride,
  type BrowserSelectionOptions,
} from '../browser-options.js';
import type { CommandContext } from '../context/command-context.js';
import { draftRunReceipt } from '../context/run-receipt.js';
import { recordTaskHistory } from '../history.js';
import { resolveAmbientContext } from '../preferences.js';
import { attachRegistered } from '../registry/build-command-tree.js';
import { handler, type Handler, type HandlerArgs } from '../registry/handler.js';
import { goalEchoEvent } from '../render/goal-echo.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';
import type { ConnectorRenderOpts } from '../render/types.js';
import { runAgenticTaskWithRankSink } from '../runtime.js';
import { TEMPLATE_LLM_GUARD, resolveTemplateRef } from '../template-ref.js';

interface DoOptions extends AgentOptions, BrowserSelectionOptions {
  readonly json?: boolean;
  readonly llm?: boolean;
  readonly template?: string;
  readonly allowHost?: string[];
  /** Promote a successful run's browser trace into a saved workflow (FEAT-027). */
  readonly saveAs?: string;
  readonly open?: boolean;
}

/** Injectable CLI boundaries for hermetic command tests. */
export interface DoRuntime {
  readonly runTask: typeof runAgenticTask;
  readonly resolveTemplate: (ref: string) => Promise<ActiveReportTemplate>;
  readonly recordHistory: (runId: string) => Promise<void>;
  readonly resolveDefaults: () => Promise<EffectivePreferences>;
  readonly resolveAgent: typeof resolveAgentInvocation;
}

/** Register `do`/`discover` without introducing any agent loop in the CLI. */
export function registerDoCommand(
  program: Command,
  runtime?: Partial<DoRuntime> & TerminalOptions,
  context?: CommandContext,
): void {
  attachRegistered(program, 'do', { do: makeDoHandler(runtime, context) });
}

/** The `do` handler over an injectable runtime, bound to the `do` registry entry. */
export function makeDoHandler(
  runtime?: Partial<DoRuntime> & TerminalOptions,
  context: CommandContext = createTerminalContext(runtime),
): Handler {
  const resolved = runtimeWithDefaults(context, runtime);
  return Object.assign(
    handler((args: HandlerArgs, options: DoOptions, command: Command) => {
      const entry = COMMAND_REGISTRY.commands.find((e) => e.id === 'do');
      if (entry?.kind === 'leaf') context.settings.bind(entry, command);
      return executeDo(args[0] as string, options, resolved, context);
    }),
    { honorsAbort: true },
  );
}

/** Map a closed agentic result to the documented CLI contract. */
export const exitCodeForDoOutcome = exitCodeForAgenticOutcome;

/**
 * The `--save-as` result line. A saved workflow names any fulfilled item it
 * could not keep (FEAT-054 D5); an unsaved one keeps its warning form.
 */
export function promotionLine(promotion: PromotionResult): string {
  if (!promotion.saved) {
    return `⚠ Could not save workflow "${promotion.workflowName}": ${promotion.error}\n`;
  }
  const omitted =
    promotion.omitted.length === 0
      ? ''
      : ` without its ${promotion.omitted.join(' and ')} step (no replay step captures a screenshot yet)`;
  const notes = promotion.notes?.map((note) => `  ${note}\n`).join('') ?? '';
  return `✓ Saved workflow "${promotion.workflowName}"${omitted}. Replay it with: yantra run ${promotion.workflowName}\n${notes}`;
}

async function executeDo(
  goal: string,
  options: DoOptions,
  runtime: DoRuntime,
  context: CommandContext,
): Promise<void> {
  // A conflicting `--browser` pair is a validation failure, resolved before any
  // provider session or run directory exists.
  const browserSelection = resolveBrowserSelectionOverride(options);
  const effective = await runtime.resolveDefaults();
  context.settings.usePreferences(effective);
  const agent = await runtime.resolveAgent('do', options, context.settings.env(), effective);
  if (agent.mode === 'no-llm') {
    if (agent.reason === 'unavailable') {
      const message =
        `No credentials available for provider "${agent.model.provider}". ` +
        'Set the provider API key, seed managed auth, or pass --auth-secret <ref>.';
      context.output.stderr.write(`AGENT_AUTH_UNAVAILABLE: ${message}\n`);
      throw new CommanderError(3, 'AGENT_AUTH_UNAVAILABLE', message);
    }
    const message =
      options.template === undefined
        ? '`do` runs a web agent and requires a model; use `ask --no-llm` or ' +
          '`research --no-llm` for deterministic web research.'
        : TEMPLATE_LLM_GUARD;
    context.output.stderr.write(`${message}\n`);
    throw new CommanderError(1, 'yantra.do.llm-required', message);
  }
  const template =
    options.template === undefined
      ? undefined
      : await runtime.resolveTemplate(options.template).catch((error: unknown) => {
          context.output.stderr.write(
            `${error instanceof Error ? error.message : String(error)}\n`,
          );
          throw error;
        });
  const json = options.json === true;
  const renderOpts: ConnectorRenderOpts = {
    json,
    debug: false,
    noColor: json || !context.output.colorCapable,
    stream: context.output.stdout,
    errStream: context.output.stderr,
    suppressOpenHint: options.open === true,
  };
  const connector = context.connector(json ? new JSONRenderer() : new TerminalRenderer(), {
    renderOpts,
    interactive: context.isInteractive({ json }),
    suppressPublishedOutcome: template !== undefined,
  });
  // The goal exactly as received, before the agent starts, so a shell-rewritten
  // argument is visible. Same spelling as `ask` and `research`; it goes through
  // the run's event stream (FEAT-063), whose renderer prints it on stderr.
  connector.runEvents.emit(goalEchoEvent(goal));

  const allowedHosts = normalizeHosts(options.allowHost ?? []);
  const receipt = await draftRunReceipt(context, ['do'], {
    agent,
    ...(template === undefined ? {} : { template }),
    ...(browserSelection === undefined ? {} : { browser: browserSelection }),
    settings: { allowHost: allowedHosts, saveAs: options.saveAs?.trim() ?? null },
  });
  try {
    const saveAs = options.saveAs?.trim();
    // Resolve the least-privilege `do` profile explicitly (tool allowlist,
    // workflow mode, budgets, task-Brief addendum) instead of relying on the
    // runtime's implicit default. This also honors the documented
    // `YANTRA_AGENT_DO_*` budget env overrides, matching the `ask` path.
    const profile = resolveCommandTaskProfile('do');
    const outcome = await runtime.runTask(
      {
        goal,
        receipt,
        profile,
        model: agent.model,
        ...(agent.thinkingSource === undefined ? {} : { thinkingSource: agent.thinkingSource }),
        auth: agent.auth,
        budgets: agent.budgets,
        allowedHosts,
        // A user is present only on an interactive TTY run (not --json / piped):
        // the agent prompt then says a user can approve protected actions but
        // cannot answer open-ended questions, instead of claiming "no user".
        interactive: context.isInteractive({ json }),
        // Sensitive ambient facts the user granted. Passed on every agentic
        // command, not just `ask` — `do` sending none is what let a run infer a
        // city from its timezone.
        ambient: resolveAmbientContext(effective),
        screenshotsSuppressed: options.screenshots === false,
        ...(saveAs && saveAs.length > 0 ? { saveAs } : {}),
        ...(template === undefined ? {} : { template }),
        connector,
        signal: context.signal,
      },
      {
        cwd: context.cwd,
        browserInstallOfferGateway: context.gateways.installOffer(context.isInteractive({ json })),
        ...(browserSelection === undefined ? {} : { browserSelection }),
      },
    );
    if (template !== undefined && outcome.kind === 'published') {
      const parsed = validateTemplatedReport(
        JSON.parse(await readFile(outcome.brief.jsonPath, 'utf8')) as unknown,
      );
      if (!parsed.isOk) {
        throw new CommanderError(
          2,
          'yantra.do.invalid-templated-report',
          'The agent published an invalid templated report artifact.',
        );
      }
      connector.renderResult(
        {
          kind: 'templated_report',
          report: parsed.value,
          artifacts: {
            jsonPath: outcome.brief.jsonPath,
            mdPath: outcome.brief.markdownPath,
            htmlPath: outcome.brief.htmlPath,
          },
        },
        renderOpts,
      );
      await runtime.recordHistory(outcome.runId);
    }
    if (!json && outcome.kind === 'published' && outcome.promotion) {
      const line = promotionLine(outcome.promotion);
      context.output.stdout.write(line);
    }
    if (options.open === true && outcome.kind === 'published')
      context.openExternal(outcome.brief.htmlPath);
    const exitCode = exitCodeForDoOutcome(outcome);
    if (exitCode !== 0) {
      const word = taskOutcomeOf(outcome);
      throw new CommanderError(exitCode, `yantra.do.${word}`, word);
    }
  } catch (error) {
    if (error instanceof UserInputMarkerError) {
      context.output.stderr.write(`${error.message}\n`);
      throw new CommanderError(1, 'yantra.do.invalid-user-input-marker', error.message);
    }
    throw error;
  }
}

function normalizeHosts(hosts: readonly string[]): string[] {
  const normalized = hosts.map(clean).map((host) => host.toLowerCase());
  for (const host of normalized) {
    if (!/^[a-z0-9.-]+(?::\d+)?$/.test(host)) {
      throw new CommanderError(
        1,
        'yantra.do.invalid-host',
        `Invalid --allow-host value "${host}".`,
      );
    }
  }
  return [...new Set(normalized)].sort();
}

function clean(value: string): string {
  return value.trim();
}

function runtimeWithDefaults(context: CommandContext, runtime?: Partial<DoRuntime>): DoRuntime {
  return {
    runTask: runtime?.runTask ?? runAgenticTaskWithRankSink,
    resolveTemplate:
      runtime?.resolveTemplate ??
      ((ref) =>
        resolveTemplateRef(ref, {
          cwd: context.cwd,
          isTty: context.isInteractive({}),
          choose: (names) => context.input.choose(names),
        })),
    recordHistory: runtime?.recordHistory ?? recordTaskHistory,
    resolveDefaults: runtime?.resolveDefaults ?? (() => context.settings.preferences()),
    resolveAgent: runtime?.resolveAgent ?? resolveAgentInvocation,
  };
}

export type { AgenticTaskOutcome };
