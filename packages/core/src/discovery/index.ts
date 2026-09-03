/**
 * Discovery mode core surface (FEAT-020): observation building (TASK-003),
 * workflow promotion (TASK-005).
 */

export {
  MAX_PAGE_DIGEST_LEN,
  buildObservation,
  mapRunOutcomeToStepOutcome,
  type BuildObservationDeps,
  type CycleExecutionSummary,
} from './observe.js';
export { MAX_INTERACTABLES, rankInteractables } from './interactables.js';
export { collectComposedInteractables, type ComposedInteractables } from './composed-handles.js';
export {
  scanInteractablesInPage,
  type InteractableScan,
  type RawInteractable,
} from './interactable-scan.js';
export {
  InteractiveConfirmationGateway,
  type ConsentRenderSink,
  type InteractiveConfirmationGatewayOptions,
} from './interactive-confirmation-gateway.js';
export {
  promoteDiscoverySession,
  promoteAgentTrace,
  type PromotableSession,
  type PromotableTraceStep,
  type PromotableFillValue,
  type PromoteError,
  type PromoteOptions,
  type PromoteTraceOptions,
} from './promote.js';
