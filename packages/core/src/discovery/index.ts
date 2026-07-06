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
export { scanInteractablesInPage, type RawInteractable } from './interactable-scan.js';
export {
  InteractiveConfirmationGateway,
  type ConsentRenderSink,
  type InteractiveConfirmationGatewayOptions,
} from './interactive-confirmation-gateway.js';
export {
  promoteDiscoverySession,
  type PromotableSession,
  type PromoteError,
  type PromoteOptions,
} from './promote.js';
