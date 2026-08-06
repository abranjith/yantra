import type { ConfirmationConnector } from './confirmation-bridge.js';
import type { AgenticTaskOutcome } from './outcome.js';

/** Bounded, render-safe progress sent from the provider seam to a connector. */
export type AgentProgressEvent =
  | { readonly type: 'assistant_text'; readonly text: string; readonly at: string }
  | {
      readonly type: 'tool_started';
      readonly tool: string;
      readonly summary: string;
      readonly at: string;
    }
  | {
      readonly type: 'tool_finished';
      readonly tool: string;
      readonly summary: string;
      readonly status: 'ok' | 'error' | 'denied' | 'aborted';
      readonly durationMs: number | null;
      readonly at: string;
    };

/** IO surface consumed by the agentic runtime (CLI today, other connectors later). */
export interface AgentTaskConnector extends ConfirmationConnector {
  /** Receive a safe advisory before run creation; JSON connectors may suppress it. */
  emitAgentWarning?(warning: string): void;
  /** Receive one sanitized, bounded progress event. */
  emitAgentEvent(event: AgentProgressEvent): void;
  /** Receive the single finalized terminal outcome. */
  renderAgentOutcome(outcome: AgenticTaskOutcome): void;
}
