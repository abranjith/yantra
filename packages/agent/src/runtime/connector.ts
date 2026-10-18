import type { DeliverableReason } from './capture-capability.js';
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
    }
  | {
      /**
       * A `task_contract` declaration succeeded (FEAT-052). `summary` is the
       * one-line echo of the normalized, sanitized contract.
       */
      readonly type: 'contract_declared';
      readonly revision: number;
      readonly summary: string;
      readonly at: string;
    }
  | {
      /**
       * A declared item this run cannot deliver (FEAT-058), disclosed once,
       * right after the declaration that introduced it. `summary` is the
       * one-line, ASCII-only disclosure; the run continues with the rest.
       */
      readonly type: 'capability_gap';
      /** The requirement id, such as `artifact:screenshot:viewport`. */
      readonly item: string;
      readonly reason: DeliverableReason;
      readonly summary: string;
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
