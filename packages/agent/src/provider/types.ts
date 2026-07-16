/**
 * The Yantra agent provider seam (plan_agentic.md §4 — authoritative).
 *
 * This file defines the ONLY session operations and normalized events Yantra
 * consumes from an agent SDK. It deliberately excludes provider messages,
 * thinking deltas, session trees, resource loaders, tool engines, model
 * registries, compaction, steering queues, and provider response objects —
 * none of those may be added without a demonstrated Yantra consumer.
 *
 * IMPORTANT: nothing in this file may import from a provider SDK. Provider
 * types must never leak through the seam; adapters translate in both
 * directions and every payload crossing the seam is post-sanitizer.
 */

/**
 * Opens agent sessions against a concrete provider backend.
 *
 * Implementations must fail with a typed startup error (`AgentStartupError`
 * carrying a plan §9 code) instead of degrading to a null or deterministic
 * client — explicit agentic commands never silently lose their provider.
 */
export interface AgentProvider {
  /**
   * Open a fresh agent session.
   *
   * @param options Immutable per-session configuration (run identity, model,
   *   auth, prompt). Each top-level run opens exactly one fresh session.
   * @returns The live session. Rejects with a typed `AgentStartupError`
   *   (`AGENT_MODEL_NOT_FOUND`, `AGENT_AUTH_UNAVAILABLE`,
   *   `AGENT_PROVIDER_UNAVAILABLE`, `AGENT_SESSION_START_FAILED`) when the
   *   session cannot be established.
   */
  open(options: AgentSessionOptions): Promise<AgentSession>;
}

/**
 * A live provider-backed agent session owned by exactly one Yantra run.
 *
 * The session is the observable surface of the provider's reasoning/tool
 * loop: Yantra runs prompts, subscribes to normalized events, and tears the
 * session down. It never reaches into provider internals.
 */
export interface AgentSession {
  /** Provider-assigned session identity (recorded in the run manifest). */
  readonly id: string;

  /**
   * Absolute path to the provider session log (JSONL). Reports the FINAL
   * location — for run-local placement this is under `<runDir>/agent/`.
   */
  readonly logPath: string;

  /** Effective credential origin recorded in the owning run manifest. */
  readonly authSource: 'managed' | 'runtime-key' | 'environment';

  /**
   * Run one prompt to completion (multi-turn, including tool calls).
   *
   * @param prompt Sanitized prompt text. Callers sanitize before the seam.
   * @returns Terminal outcome, stop reason, and aggregated usage. Provider
   *   failures surface as `outcome: 'failed'` (with a `failed` event), not as
   *   rejections; rejections are reserved for misuse (e.g. run after close).
   */
  run(prompt: string): Promise<AgentRunResult>;

  /**
   * Subscribe to normalized session events.
   *
   * @param listener Receives every `AgentEvent` (payloads post-sanitizer).
   * @returns Unsubscribe function for this listener.
   */
  subscribe(listener: (event: AgentEvent) => void): () => void;

  /**
   * Abort the in-flight run (user interrupt or budget exhaustion) and wait
   * for the provider loop to become idle. Idempotent.
   */
  abort(): Promise<void>;

  /**
   * Release the session: detach listeners and finalize the session log at
   * `logPath`. Idempotent; safe to call after `abort()`.
   */
  close(): Promise<void>;
}

/** Immutable configuration for opening one agent session. */
export interface AgentSessionOptions {
  /** Owning Yantra run ID; the session is an artifact of this run. */
  readonly runId: string;
  /** Absolute path of the owning run directory (session log lands under `<runDir>/agent/`). */
  readonly runDir: string;
  /** Working directory recorded for the session (never used for resource discovery). */
  readonly cwd: string;
  /** Model to resolve at startup; unknown models are a typed failure. */
  readonly model: AgentModelSelection;
  /** How model credentials are resolved for this session. */
  readonly auth: AgentAuthSelection;
  /** The complete, versioned system prompt. No ambient prompt sources are consulted. */
  readonly systemPrompt: string;
}

/** Provider/model coordinates plus optional reasoning effort. */
export interface AgentModelSelection {
  /** Provider key, e.g. `anthropic` or `ollama`. */
  readonly provider: string;
  /** Provider-scoped model identifier. */
  readonly id: string;
  /** Optional thinking/reasoning level (provider adapters clamp to model capability). */
  readonly thinking?: string;
}

/**
 * Model credential selection.
 *
 * - `managed` — the adapter's pinned credential store (plus provider
 *   environment variables as a supported fallback).
 * - `runtime-key` — a Yantra secret reference resolved at startup into a
 *   runtime-only key that is never persisted or logged.
 */
export type AgentAuthSelection =
  | { readonly mode: 'managed' }
  | { readonly mode: 'runtime-key'; readonly secretRef: string };

/**
 * Normalized session events (closed union — plan §4).
 *
 * Every payload (tool inputs/outputs, text, errors) is post-sanitizer; the
 * adapter never forwards raw provider payloads across the seam.
 */
export type AgentEvent =
  | {
      /** A tool invocation started. */
      readonly type: 'tool_started';
      /** Provider call identity; pairs this start with its finish. */
      readonly callId: string;
      /** Registered tool name (snake_case). */
      readonly tool: string;
      /** Sanitized tool input. */
      readonly input: unknown;
      /** ISO-8601 timestamp. */
      readonly at: string;
    }
  | {
      /** A tool invocation finished (successfully or not). */
      readonly type: 'tool_finished';
      /** Provider call identity; pairs this finish with its start. */
      readonly callId: string;
      /** Registered tool name (snake_case). */
      readonly tool: string;
      /** Sanitized tool output. */
      readonly output: unknown;
      /** True when the tool result is an error result. */
      readonly isError: boolean;
      /** ISO-8601 timestamp. */
      readonly at: string;
    }
  | {
      /** Incremental assistant text (consumed by ConnectorIO streaming). */
      readonly type: 'assistant_text';
      /** Sanitized text delta. */
      readonly text: string;
      /** ISO-8601 timestamp. */
      readonly at: string;
    }
  | {
      /** One provider turn completed (consumed by run-level usage aggregation). */
      readonly type: 'turn_finished';
      /** Usage for this turn (turns === 1). */
      readonly usage: AgentUsage;
      /** ISO-8601 timestamp. */
      readonly at: string;
    }
  | {
      /** The session failed; a terminal `run()` outcome of `failed` follows. */
      readonly type: 'failed';
      /** Stable-coded, sanitized error. */
      readonly error: AgentError;
      /** ISO-8601 timestamp. */
      readonly at: string;
    };

/** Terminal result of one `AgentSession.run()`. */
export interface AgentRunResult {
  /** How the run ended. Closed union — no other terminal states exist. */
  readonly outcome: 'completed' | 'failed' | 'aborted';
  /** Provider stop reason (informational; not a stable contract). */
  readonly stopReason: string;
  /** Usage aggregated across all turns of this run. */
  readonly usage: AgentUsage;
}

/** Usage metrics; optional fields appear only when the provider reports them. */
export interface AgentUsage {
  /** Number of completed provider turns. */
  readonly turns: number;
  /** Input tokens, when reported. */
  readonly inputTokens?: number;
  /** Output tokens, when reported. */
  readonly outputTokens?: number;
  /** Estimated cost in USD, when reported. */
  readonly costUsd?: number;
}

/** Stable-coded, render-safe error surfaced through `failed` events and results. */
export interface AgentError {
  /** One of the plan §9 stable codes (e.g. `AGENT_SESSION_START_FAILED`). */
  readonly code: string;
  /** Sanitized message — safe for rendering and run artifacts; never contains key material. */
  readonly message: string;
}
