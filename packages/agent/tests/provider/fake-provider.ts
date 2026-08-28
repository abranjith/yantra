/**
 * In-memory fake implementation of the agent provider seam.
 *
 * Used by the seam contract tests (FEAT-022) and reused by orchestrator
 * lifecycle tests (FEAT-026) so orchestration logic can be exercised without
 * a provider SDK. The fake type-checks against the real seam interfaces —
 * if the seam changes shape, this file fails `tsc -p tsconfig.tests.json`.
 */

import type {
  AgentEvent,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentSessionOptions,
} from '../../src/provider/index.js';

/** Scripted behavior for a {@link FakeAgentSession}. */
export interface FakeSessionScript {
  /** Events emitted to subscribers when `run()` is called, in order. */
  readonly eventsOnRun?: readonly AgentEvent[];
  /** Result resolved by `run()`. Defaults to a completed run with one turn. */
  readonly runResult?: AgentRunResult;
  /** Per-run event batches (used by completion-nudge orchestration tests). */
  readonly eventsByRun?: readonly (readonly AgentEvent[])[];
  /** Per-run terminal results. */
  readonly resultsByRun?: readonly AgentRunResult[];
  /** Hook for artifact creation or additional scripted assertions. */
  readonly onRun?: (
    prompt: string,
    runIndex: number,
    session: FakeAgentSession,
  ) => Promise<void> | void;
}

const DEFAULT_RUN_RESULT: AgentRunResult = {
  outcome: 'completed',
  stopReason: 'stop',
  usage: { turns: 1 },
};

/** In-memory `AgentSession` driven by a {@link FakeSessionScript}. */
export class FakeAgentSession implements AgentSession {
  public readonly id: string;
  public readonly logPath: string;
  public readonly authSource = 'managed' as const;

  public runPrompts: string[] = [];
  public abortCount = 0;
  public closeCount = 0;

  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly script: FakeSessionScript;

  public constructor(options: AgentSessionOptions, script: FakeSessionScript = {}) {
    this.id = `fake-session-${options.runId}`;
    this.logPath = `${options.runDir}/agent/${this.id}.jsonl`;
    this.script = script;
  }

  public async run(prompt: string): Promise<AgentRunResult> {
    const runIndex = this.runPrompts.length;
    this.runPrompts.push(prompt);
    await this.script.onRun?.(prompt, runIndex, this);
    for (const event of this.script.eventsByRun?.[runIndex] ?? this.script.eventsOnRun ?? []) {
      this.emit(event);
    }
    return this.script.resultsByRun?.[runIndex] ?? this.script.runResult ?? DEFAULT_RUN_RESULT;
  }

  public subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public abort(): Promise<void> {
    this.abortCount += 1;
    return Promise.resolve();
  }

  public close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }

  /** Push an event to all current subscribers (test hook). */
  public emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/** In-memory `AgentProvider` that records `open()` calls and hands out fakes. */
export class FakeAgentProvider implements AgentProvider {
  public openedWith: AgentSessionOptions[] = [];
  public sessions: FakeAgentSession[] = [];

  public constructor(private readonly script: FakeSessionScript = {}) {}

  public open(options: AgentSessionOptions): Promise<AgentSession> {
    this.openedWith.push(options);
    const session = new FakeAgentSession(options, this.script);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}
