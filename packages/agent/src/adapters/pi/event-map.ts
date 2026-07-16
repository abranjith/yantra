/**
 * Pi session event → normalized `AgentEvent` mapping (FEAT-022 TASK-004).
 *
 * This file is the de-facto specification for any future second adapter:
 * every mapping decision is documented inline. The invariant it enforces is
 * plan §4's sanitization rule — **every** payload crossing the seam (tool
 * inputs/outputs, assistant text, error messages) passes the core sanitizer
 * before emission; raw Pi payloads are never forwarded.
 */

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { sanitize } from '@yantra/core';

import type { AgentError, AgentEvent, AgentUsage } from '../../provider/types.js';

/**
 * Sanitization/clock dependencies, injectable for tests.
 */
export interface PiEventMapContext {
  /** Sanitize an arbitrary payload for seam emission. */
  readonly sanitizePayload: (payload: unknown) => unknown;
  /** Sanitize a text fragment for seam emission. */
  readonly sanitizeText: (text: string) => string;
  /** ISO-8601 timestamp source. */
  readonly now: () => string;
}

/**
 * Terminal information extracted from a Pi `agent_end` event; drives the
 * `AgentRunResult` outcome in the adapter's `run()`.
 */
export interface PiTerminalState {
  /** Provider stop reason of the final assistant message ('stop' when absent). */
  readonly stopReason: string;
  /** Sanitized provider error message, present when the run failed. */
  readonly errorMessage?: string;
}

/**
 * Build the default mapping context backed by the core sanitizer.
 *
 * Mapping decision: the `authenticated` profile is applied to every payload.
 * It is the strictest profile (form values, all query strings, PII, and
 * credential-shaped substrings) — tool output and page-derived content are
 * adversarial by default at this seam. FEAT-024's tool middleware applies
 * finer-grained, class-aware profiles *before* results ever reach Pi; this
 * pass is the last line of defense, not the primary one.
 */
export function createDefaultPiEventMapContext(): PiEventMapContext {
  const sanitizeText = (text: string): string => sanitize(text, 'authenticated').text;
  return {
    sanitizeText,
    // Mapping decision: the sanitizer is text-based, so structured payloads
    // are serialized, sanitized, then re-parsed when the result is still
    // valid JSON. Redaction or truncation can break JSON validity — in that
    // case the sanitized *text* is emitted. Consumers treat `input`/`output`
    // as opaque `unknown` either way.
    sanitizePayload: (payload: unknown): unknown => {
      const sanitized = sanitize(payload, 'authenticated');
      if (typeof payload === 'string') {
        return sanitized.text;
      }
      try {
        return JSON.parse(sanitized.text) as unknown;
      } catch {
        return sanitized.text;
      }
    },
    now: () => new Date().toISOString(),
  };
}

/**
 * Map one Pi session event onto zero or more normalized seam events.
 *
 * Mapping table (Pi → seam):
 *
 * | Pi event                | Seam event        | Notes                                    |
 * | ----------------------- | ----------------- | ---------------------------------------- |
 * | `tool_execution_start`  | `tool_started`    | args sanitized                           |
 * | `tool_execution_end`    | `tool_finished`   | result sanitized, `isError` passthrough  |
 * | `message_update`        | `assistant_text`  | `text_delta` fragments only              |
 * | `turn_end`              | `turn_finished`   | usage of the turn's assistant message    |
 * | `agent_end` (error)     | `failed`          | final stopReason `error`, no retry pending |
 * | anything else           | (none)            | ignored — drift tolerance                |
 *
 * Deliberate exclusions (documented for the next adapter):
 * - Thinking deltas are never forwarded — the seam has no consumer and they
 *   would widen the surface Yantra must sanitize and persist.
 * - `tool_execution_update` (partial results) is dropped; the seam models
 *   tool calls as start/finish pairs only.
 * - Pi session-management events (compaction, queue, retry, branch) are
 *   internal provider mechanics that Yantra observes only through the raw
 *   session artifact.
 * - `agent_end` with `willRetry: true` is not a failure — Pi's auto-retry is
 *   in flight and a later `agent_end` settles the run.
 *
 * @param event Raw Pi session event (never re-emitted).
 * @param ctx Sanitizer/clock context.
 * @returns Normalized events to emit, in order (possibly empty).
 */
export function mapPiEvent(event: AgentSessionEvent, ctx: PiEventMapContext): AgentEvent[] {
  switch (event.type) {
    case 'tool_execution_start':
      return [
        {
          type: 'tool_started',
          callId: event.toolCallId,
          tool: event.toolName,
          input: ctx.sanitizePayload(event.args),
          at: ctx.now(),
        },
      ];

    case 'tool_execution_end':
      return [
        {
          type: 'tool_finished',
          callId: event.toolCallId,
          tool: event.toolName,
          output: ctx.sanitizePayload(event.result),
          isError: event.isError,
          at: ctx.now(),
        },
      ];

    case 'message_update': {
      // Only assistant text deltas cross the seam (ConnectorIO streaming is
      // the consumer). A credential split across two deltas can evade shape
      // detection here; the authoritative guarantee is that secrets never
      // enter the model in the first place (opaque refs + tool middleware).
      const streamEvent = event.assistantMessageEvent;
      if (streamEvent.type === 'text_delta') {
        return [
          { type: 'assistant_text', text: ctx.sanitizeText(streamEvent.delta), at: ctx.now() },
        ];
      }
      return [];
    }

    case 'turn_end':
      return [{ type: 'turn_finished', usage: usageOfTurn(event.message), at: ctx.now() }];

    case 'agent_end': {
      if (event.willRetry) {
        return [];
      }
      const terminal = extractTerminalState(event.messages, ctx);
      if (terminal.stopReason === 'error') {
        const error: AgentError = {
          // Mapping decision: a mid-run provider error (overload, exhausted
          // retries, transport drop) is normalized to the plan §9 transport
          // code. Startup problems never reach this path — they are typed
          // failures thrown from `open()`.
          code: 'AGENT_PROVIDER_UNAVAILABLE',
          message: terminal.errorMessage ?? 'provider reported an error',
        };
        return [{ type: 'failed', error, at: ctx.now() }];
      }
      return [];
    }

    default:
      // Drift tolerance: unknown/unmapped Pi events are ignored, never thrown
      // on — a minor SDK addition must not break the seam.
      return [];
  }
}

/**
 * Extract the terminal stop reason / error of a finished Pi run from its
 * message list (the payload of `agent_end`).
 *
 * @param messages Pi agent messages of the settled run.
 * @param ctx Sanitizer context (error messages are payloads too).
 */
export function extractTerminalState(
  messages: readonly unknown[],
  ctx: PiEventMapContext,
): PiTerminalState {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (isAssistantMessage(message)) {
      const stopReason = typeof message.stopReason === 'string' ? message.stopReason : 'stop';
      if (typeof message.errorMessage === 'string' && message.errorMessage.length > 0) {
        return { stopReason, errorMessage: ctx.sanitizeText(message.errorMessage) };
      }
      return { stopReason };
    }
  }
  return { stopReason: 'stop' };
}

/**
 * Usage of one completed turn.
 *
 * Mapping decision: `inputTokens`/`outputTokens` are the provider's fresh
 * input/output counts; cache read/write tokens are intentionally not folded
 * in — the raw Pi session artifact retains the full breakdown for anyone who
 * needs it. `costUsd` is the provider's total for the turn.
 */
function usageOfTurn(message: unknown): AgentUsage {
  if (!isAssistantMessage(message) || message.usage === undefined) {
    return { turns: 1 };
  }
  const { usage } = message;
  return {
    turns: 1,
    ...(typeof usage.input === 'number' ? { inputTokens: usage.input } : {}),
    ...(typeof usage.output === 'number' ? { outputTokens: usage.output } : {}),
    ...(typeof usage.cost?.total === 'number' ? { costUsd: usage.cost.total } : {}),
  };
}

interface AssistantMessageShape {
  readonly role: 'assistant';
  readonly stopReason?: unknown;
  readonly errorMessage?: unknown;
  readonly usage?: {
    readonly input?: unknown;
    readonly output?: unknown;
    readonly cost?: { readonly total?: unknown };
  };
}

function isAssistantMessage(message: unknown): message is AssistantMessageShape {
  return (
    typeof message === 'object' &&
    message !== null &&
    'role' in message &&
    message.role === 'assistant'
  );
}
