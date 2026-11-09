import type { AgentProgressEvent } from '@yantra/protocol';

import type { ConfirmationConnector } from './confirmation-bridge.js';
import type { AgenticTaskOutcome } from './outcome.js';

/**
 * Bounded, render-safe progress sent from the provider seam to a connector.
 * Defined once in `@yantra/protocol` (FEAT-063), where it also builds the
 * matching `RunEvent` variants; re-exported here for existing connectors.
 */
export type { AgentProgressEvent };

/** IO surface consumed by the agentic runtime (CLI today, other connectors later). */
export interface AgentTaskConnector extends ConfirmationConnector {
  /** Receive a safe advisory before run creation; JSON connectors may suppress it. */
  emitAgentWarning?(warning: string): void;
  /** Receive one sanitized, bounded progress event. */
  emitAgentEvent(event: AgentProgressEvent): void;
  /** Receive the single finalized terminal outcome. */
  renderAgentOutcome(outcome: AgenticTaskOutcome): void;
}
