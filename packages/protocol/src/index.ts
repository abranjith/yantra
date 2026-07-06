export { emitJsonSchemas, JSON_SCHEMA_ARTIFACTS } from './emit/json-schema.js';
export { emitProtocolSpecDoc } from './emit/spec-doc.js';
export {
  createToolCatalog,
  emitToolCatalog,
  type ToolCatalog,
  type ToolDefinition,
} from './emit/tool-catalog.js';

export {
  BRIEF_SCHEMA_VERSION,
  Brief,
  BriefFacets,
  BriefMetadata,
  BriefNotice,
  BriefSource,
  KeyFinding,
  Section,
} from './schemas/brief.js';
export {
  BriefValidationError,
  appendNotice,
  createBrief,
  validateBrief,
  type BriefValidationIssue,
  type CreateBriefInput,
} from './schemas/brief-builder.js';
export { TaskEvent, HandoffReason } from './schemas/events.js';
export {
  CONFIRMABLE_ACTION_KINDS,
  ConfirmationDecidedBy,
  ConfirmationDecision,
  ConfirmationRequest,
  ConsequenceLevel,
  ExpectedCost,
} from './schemas/confirmation.js';
export type {
  ConfirmableActionKind,
  ConfirmationDecidedBy as ConfirmationDecidedByType,
  ConfirmationDecision as ConfirmationDecisionType,
  ConfirmationRequest as ConfirmationRequestType,
  ConsequenceLevel as ConsequenceLevelType,
  ExpectedCost as ExpectedCostType,
} from './schemas/confirmation.js';
export {
  ExtractionErrorRow,
  ExtractionResultEnvelopeUnknown,
  extractionResultEnvelope,
  filterValidExtractionRows,
  isExtractionErrorRow,
} from './schemas/extraction.js';
export { OutputBinding, PlanSchema, TaskMismatchError, assertSameTask } from './schemas/plan.js';
export {
  CaptureRef,
  LiteralValue,
  LocatorChain,
  NameMatch,
  ParamRef,
  RoleEnum,
  SecretRef,
  TemplateRef,
  ValueRef,
} from './schemas/refs.js';
export type { IntentLocatorChain } from './schemas/refs.js';
export {
  ALLOWED_VERBS_BY_SCOPE,
  FailureClass,
  STEP_VERBS,
  SecurityClass,
  SecurityScope,
} from './schemas/security.js';
export type { StepVerb } from './schemas/security.js';
export {
  AssertCondition,
  AssertStep,
  BranchCondition,
  BranchStep,
  CallWorkflowStep,
  ClickModifiers,
  ClickStep,
  ConfirmationAnnotations,
  ExtractStep,
  ExtractionSchema,
  FillStep,
  LLMSummarizeStep,
  LoopStep,
  NavigateStep,
  Step,
  WaitForStep,
} from './schemas/steps.js';
export { BudgetSchema, ScalarValue, TaskRequest } from './schemas/task.js';
export {
  UsageCall,
  UsageLedger,
  UsageProvider,
  validateUsageLedgerTotals,
} from './schemas/usage.js';
export {
  LocatorCandidate,
  ParamDeclaration,
  RegexShape,
  WorkflowFile,
  WorkflowOutput,
  WorkflowStep,
  WorkflowValueExpression,
} from './schemas/workflow.js';
export {
  CapturedActionSchema,
  ClickActionSchema,
  ElementDescriptorSchema,
  FillActionSchema,
  InputTypeHintSchema,
  NavigateActionSchema,
  RankedCandidateSchema,
  RecordingDraftSchema,
  RecordingMetadataSchema,
  StopReasonSchema,
  WaitActionSchema,
  type CapturedAction,
  type ClickAction,
  type ElementDescriptor,
  type FillAction,
  type InputTypeHint,
  type NavigateAction,
  type RankedCandidate,
  type RawCapturedActionInput,
  type RawFillAction,
  type RecordingDraft,
  type RecordingMetadata,
  type StopReason,
  type WaitAction,
} from './schemas/recording-draft.js';
export {
  BudgetSnapshot,
  DiscoveryBudget,
  DiscoveryCycle,
  DiscoveryDone,
  DiscoveryObservation,
  DiscoveryOutcome,
  DiscoveryProposal,
  DiscoverySession,
  DiscoveryStepOutcome,
  DiscoveryValidation,
  InteractableDescriptor,
  normalizeProposal,
  validateDiscoveryProposal,
} from './schemas/discovery.js';
export type {
  BudgetSnapshot as BudgetSnapshotType,
  DiscoveryBudget as DiscoveryBudgetType,
  DiscoveryCycle as DiscoveryCycleType,
  DiscoveryDone as DiscoveryDoneType,
  DiscoveryObservation as DiscoveryObservationType,
  DiscoveryOutcome as DiscoveryOutcomeType,
  DiscoveryProposal as DiscoveryProposalType,
  DiscoverySession as DiscoverySessionType,
  DiscoveryStepOutcome as DiscoveryStepOutcomeType,
  DiscoveryValidation as DiscoveryValidationType,
  InteractableDescriptor as InteractableDescriptorType,
} from './schemas/discovery.js';

export { err, ok, type Result } from './utils/result.js';
export { ULID_PATTERN, generateUlid } from './utils/ulid.js';
export {
  ValidationError,
  validateSemantics,
  validateWorkflowSemantics,
  type SemanticValidationContext,
  type ValidatedPlan,
  type ValidatedWorkflow,
  type ValidationWarning,
} from './validators/semantic.js';
export {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  VersionError,
  parseSchemaVersion,
  selectValidator,
  type PlanValidator,
  type SchemaVersion,
} from './version.js';

export type { Plan } from './schemas/plan.js';
export type { TaskRequest as TaskRequestType } from './schemas/task.js';
export type { Step as StepType } from './schemas/steps.js';
export type { WorkflowFile as WorkflowFileType } from './schemas/workflow.js';

// Compatibility export used by FEAT-001 scaffold smoke tests.
export const PROTOCOL_VERSION = '0.0.0' as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;
