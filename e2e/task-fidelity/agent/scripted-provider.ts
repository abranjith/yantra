/**
 * `ScriptedAgentProvider`: an `AgentProvider` that plays a fixed script against
 * the run's own wrapped tools (FEAT-049 TASK-005).
 *
 * It stands where a model would and does nothing a model could not: it calls
 * the tools the run's profile registered, through the full middleware, and
 * reports their lifecycle exactly as the Pi seam does — `tool_finished.output`
 * is {@link auditProjectionOf}, the projection a real session records — so
 * the run recorder writes `tool-calls.jsonl` the same way for both.
 *
 * Scripts use only engineered moves. Every URL a step uses comes from a
 * fixture origin the SERP seeded or from a field a prior result actually
 * carries. A resolver that cannot find its input returns `null`: the step is
 * recorded as unreachable and no call is made. A resolver never invents a URL,
 * so an unreachable list is a measurement of what the tools did not offer.
 */

import {
  auditProjectionOf,
  buildYantraWrappedTools,
  type AgentEvent,
  type AgentProvider,
  type AgentRunResult,
  type AgentSession,
  type CommandTaskProfile,
  type RunServices,
  type WrappedTool,
} from '@yantra/agent';
import { sanitizeStructured } from '@yantra/core';

/** Parameters for a call, or a resolver that derives them from the evidence so far. */
export type StepParams =
  | Readonly<Record<string, unknown>>
  | ((ctx: ScriptContext) => Readonly<Record<string, unknown>> | null);

/** One step of a script. */
export type ScriptStep =
  | {
      readonly kind: 'call';
      readonly tool: string;
      /** Names the step in `unreachable`/`skipped` lists; defaults to the tool name. */
      readonly label?: string;
      readonly params: StepParams;
      /**
       * Runs the step only when true. A step whose guard is false is recorded as
       * skipped — a move the script did not need — never as unreachable.
       */
      readonly when?: (ctx: ScriptContext) => boolean;
    }
  | { readonly kind: 'parallel'; readonly steps: readonly ScriptStep[] }
  /**
   * Time passing between tool calls, as a long model turn spends it: advances
   * the run's budget clock by `ms` (FEAT-054). No tool is called and no turn
   * is counted. Only meaningful when the runner wires a harness clock.
   */
  | { readonly kind: 'advance-clock'; readonly ms: number }
  | { readonly kind: 'think'; readonly ms: number }
  /**
   * Stands in for a stored-secret fill (FEAT-058): sets the run's
   * sensitive-screen latch on the current document, exactly where
   * `browser_fill_element` sets it before dispatching a resolved secret. The
   * fill itself cannot run here, because the harness denies every
   * confirmation and a secret fill always asks. No tool is called and no turn
   * is counted.
   */
  | { readonly kind: 'latch-sensitive-screen' };

/** One tool call the scripted agent made, as it received the result. */
export interface ReceivedResult {
  readonly label: string;
  readonly tool: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly status: string;
  readonly errorCode: string | null;
  /** The model-visible payload, parsed from `modelText` when it is JSON. */
  readonly model: unknown;
  readonly modelText: string;
  readonly details: unknown;
  /** The audit projection emitted as `tool_finished.output`. */
  readonly audit: unknown;
  /** Wall-clock call window (ms since epoch), comparable with fixture request times. */
  readonly startedAt: number;
  readonly endedAt: number;
}

/** A link a result offers (FEAT-051 wire form `{ text, url, kind }`). */
export interface OfferedLink {
  readonly text: string;
  readonly url: string;
  readonly kind: string;
}

/** A record a result offers (FEAT-051 wire form). */
export interface OfferedRecord {
  readonly id: string;
  readonly title: string | null;
  readonly url: string | null;
  readonly [field: string]: unknown;
}

/**
 * What a resolver may read: the results received so far, plus pickers that
 * read only fields a result actually carries.
 */
export interface ScriptContext {
  readonly steers: () => readonly string[];
  readonly results: readonly ReceivedResult[];
  /** The most recent result of `tool` (or of any tool), if any. */
  last(tool?: string): ReceivedResult | undefined;
  /** Results labelled `label`, in call order. */
  labelled(label: string): readonly ReceivedResult[];
  /**
   * The first URL any search result offered (site, discovery, or more-results
   * entry) whose host satisfies `host`, or null.
   */
  urlFromSearch(host?: string): string | null;
  /** Links of `kind` a result offers in its `links[]`; empty when it offers none. */
  linksOfKind(kind: string, from?: ReceivedResult): readonly OfferedLink[];
  /** Records a result offers in its `records[]`; empty when it offers none. */
  recordsFrom(from?: ReceivedResult): readonly OfferedRecord[];
}

/** The scripted agent's account of what it did. */
export interface ScriptReport {
  readonly results: readonly ReceivedResult[];
  /** Labels of steps whose resolver found nothing to act on. */
  readonly unreachable: readonly string[];
  /** Labels of steps whose guard declined them. */
  readonly skipped: readonly string[];
  /** Top-level script steps executed (one `turn_finished` each). */
  readonly turns: number;
  /** The tool catalog the run's profile gave the agent, sorted by name. */
  readonly registeredTools: readonly string[];
  /** The first prompt the run sent: the per-run user prompt. Null before the run. */
  readonly prompt: string | null;
}

/** Zero-cost usage for a scripted turn, so turn accounting runs its real path. */
const SCRIPTED_TURN_USAGE = { turns: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 } as const;

/** An `AgentProvider` that executes a script instead of asking a model. */
export class ScriptedAgentProvider implements AgentProvider {
  private readonly received: ReceivedResult[] = [];
  private readonly unreachableSteps: string[] = [];
  private readonly skippedSteps: string[] = [];
  private turnCount = 0;
  private catalog: readonly string[] = [];
  private firstPrompt: string | null = null;

  /**
   * @param services The run's services (from `createProvider`).
   * @param script The steps to execute on the first prompt.
   * @param profile The run's command profile: the agent sees exactly the tools it registers.
   */
  public constructor(
    private readonly services: RunServices,
    private readonly script: readonly ScriptStep[],
    private readonly profile: Pick<CommandTaskProfile, 'toolNames' | 'workflowToolMode'>,
    /** Advances the run's budget clock; a no-op when the runner wires none. */
    private readonly advanceClock: (ms: number) => void = () => undefined,
  ) {}

  /** Everything the agent did, readable after the run. */
  public report(): ScriptReport {
    return {
      results: [...this.received],
      unreachable: [...this.unreachableSteps],
      skipped: [...this.skippedSteps],
      turns: this.turnCount,
      registeredTools: this.catalog,
      prompt: this.firstPrompt,
    };
  }

  public open(options: { readonly runDir: string }): Promise<AgentSession> {
    const tools = new Map<string, WrappedTool>(
      buildYantraWrappedTools(this.services, this.profile).map((tool) => [tool.name, tool]),
    );
    this.catalog = [...tools.keys()].sort();
    const listeners = new Set<(event: AgentEvent) => void>();
    const emit = (event: AgentEvent): void => {
      for (const listener of listeners) listener(event);
    };
    let prompts = 0;
    let calls = 0;
    let cursor = 0;
    let running = false;
    let aborted = false;
    let endThinking: (() => void) | undefined;

    const execute = async (step: ScriptStep): Promise<void> => {
      if (step.kind === 'think') {
        emit({ type: 'turn_started', at: new Date().toISOString() });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            endThinking = undefined;
            resolve();
          }, step.ms);
          endThinking = () => {
            clearTimeout(timer);
            endThinking = undefined;
            resolve();
          };
        });
        return;
      }
      if (step.kind === 'advance-clock') {
        this.advanceClock(step.ms);
        return;
      }
      if (step.kind === 'latch-sensitive-screen') {
        const browser = this.services.domain.browser;
        browser?.sensitiveScreenLatch?.latch(browser.controller.topLevelDocumentEpoch?.() ?? null);
        return;
      }
      if (step.kind === 'parallel') {
        // Pi issues a multi-tool turn concurrently; events interleave in real
        // completion order because each call emits its own pair.
        await Promise.all(step.steps.map((inner) => execute(inner)));
        return;
      }
      const label = step.label ?? step.tool;
      const ctx = this.context();
      if (step.when !== undefined && !step.when(ctx)) {
        this.skippedSteps.push(label);
        return;
      }
      const params = typeof step.params === 'function' ? step.params(ctx) : step.params;
      if (params === null) {
        this.unreachableSteps.push(label);
        return;
      }
      const tool = tools.get(step.tool);
      if (tool === undefined) {
        // The profile does not register this tool: a model could not call it either.
        this.unreachableSteps.push(`${label} (tool not registered)`);
        return;
      }
      emit({ type: 'turn_started', at: new Date().toISOString() });
      emit({ type: 'output_started', at: new Date().toISOString() });
      const callId = `scripted-${(calls += 1)}`;
      emit({
        type: 'tool_started',
        callId,
        tool: step.tool,
        // The Pi seam sanitizes tool inputs with this exact call.
        input: sanitizeStructured(params, 'authenticated').value,
        at: new Date().toISOString(),
      });
      const startedAt = Date.now();
      const result = await tool.execute(params, undefined);
      const endedAt = Date.now();
      const audit = auditProjectionOf(result);
      emit({
        type: 'tool_finished',
        callId,
        tool: step.tool,
        output: audit,
        isError: result.status !== 'ok',
        at: new Date().toISOString(),
      });
      this.received.push({
        label,
        tool: step.tool,
        params,
        status: result.status,
        errorCode: result.error_code ?? null,
        model: parseJson(result.modelText),
        modelText: result.modelText,
        details: result.details,
        audit,
        startedAt,
        endedAt,
      });
    };

    const session: AgentSession = {
      id: 'scripted-agent',
      // Absolute and inside the run directory: the recorder refuses a session
      // file it cannot prove the run owns.
      logPath: `${options.runDir}/agent/scripted-agent.jsonl`,
      authSource: 'managed',
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      steer: (text) => {
        if (!running) return Promise.resolve('idle');
        this.steering.push(text);
        return Promise.resolve('queued');
      },
      abort: () => {
        aborted = true;
        endThinking?.();
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
      run: async (prompt: string): Promise<AgentRunResult> => {
        // Re-prompts resume after an aborted thinking step in this same
        // session. Once the script is spent, a completion nudge cannot invent
        // a publication or replay earlier calls.
        if (prompts++ === 0) this.firstPrompt = prompt;
        running = true;
        aborted = false;
        try {
          while (cursor < this.script.length && !aborted) {
            const step = this.script[cursor++]!;
            await execute(step);
            if (step.kind === 'advance-clock' || step.kind === 'latch-sensitive-screen') continue;
            this.turnCount += 1;
            emit({
              type: 'turn_finished',
              usage: SCRIPTED_TURN_USAGE,
              at: new Date().toISOString(),
            });
          }
          return {
            outcome: aborted ? 'aborted' : 'completed',
            stopReason: aborted ? 'aborted' : 'stop',
            usage: { ...SCRIPTED_TURN_USAGE, turns: this.turnCount },
          };
        } finally {
          running = false;
        }
      },
    };
    return Promise.resolve(session);
  }

  private readonly steering: string[] = [];

  private context(): ScriptContext {
    const results = [...this.received];
    const last = (tool?: string): ReceivedResult | undefined =>
      [...results].reverse().find((result) => tool === undefined || result.tool === tool);
    return {
      steers: () => [...this.steering],
      results,
      last,
      labelled: (label) => results.filter((result) => result.label === label),
      urlFromSearch: (host) => {
        for (const result of results) {
          if (result.tool !== 'web_search' || result.status !== 'ok') continue;
          for (const url of offeredSearchUrls(result.model)) {
            if (host === undefined || hostOf(url) === host) return url;
          }
        }
        return null;
      },
      linksOfKind: (kind, from) =>
        arrayField(from === undefined ? last()?.model : from.model, 'links')
          .filter(isOfferedLink)
          .filter((link) => link.kind === kind),
      recordsFrom: (from) =>
        arrayField(from === undefined ? last()?.model : from.model, 'records').filter(
          isOfferedRecord,
        ),
    };
  }
}

/** Every URL a `web_search` payload offers, in the order the model sees them. */
function offeredSearchUrls(model: unknown): string[] {
  const urls: string[] = [];
  for (const field of ['sites', 'results', 'more_results']) {
    for (const entry of arrayField(model, field)) {
      if (isRecord(entry) && typeof entry.url === 'string') urls.push(entry.url);
    }
  }
  return urls;
}

function arrayField(model: unknown, field: string): readonly unknown[] {
  if (!isRecord(model)) return [];
  const value = model[field];
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOfferedLink(value: unknown): value is OfferedLink {
  return (
    isRecord(value) &&
    typeof value.url === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.text === 'string'
  );
}

function isOfferedRecord(value: unknown): value is OfferedRecord {
  return isRecord(value) && typeof value.id === 'string';
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    // swallow-ok: an unparseable offered URL matches no host.
    return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // swallow-ok: non-JSON model text is kept as the string it is.
    return text;
  }
}
