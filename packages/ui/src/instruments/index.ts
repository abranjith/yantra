/**
 * Drshya instruments: product components built from primitives and protocol
 * types (FEAT-065, FEAT-066). Browser code only.
 */

export {
  Bindu,
  BINDU_LABELS,
  BINDU_STATES,
  binduStyles,
  type BinduProps,
  type BinduState,
} from './bindu.js';
export {
  DISPLAYED_STATE_LABELS,
  OUTCOME_WORDS,
  OutcomeBadge,
  outcomeBadgeStyles,
  outcomeText,
  type OutcomeBadgeProps,
} from './OutcomeBadge.js';
export { CitationChip, citationLabel, type CitationChipProps } from './CitationChip.js';
export {
  CAPTURE_IMAGE_CAP_BYTES,
  CaptureGallery,
  groupCaptureSets,
  type CaptureGalleryProps,
  type CaptureItem,
} from './CaptureGallery.js';
export { ConditionTable, type ConditionTableProps } from './ConditionTable.js';
export { RequirementList, StatusWord, type RequirementListProps } from './RequirementList.js';
export {
  SafeMarkdown,
  isSafeExternalHref,
  parseCitationRef,
  remarkCitations,
  type CitationContext,
  type CitationRef,
  type SafeMarkdownProps,
} from './SafeMarkdown.js';
export { ACTION_NOT_RECORDED, ActionEvidence, type ActionEvidenceProps } from './ActionEvidence.js';
export {
  EvidencePane,
  SourceEvidence,
  type EvidenceBackReference,
  type EvidencePaneProps,
  type SourceEvidenceProps,
} from './EvidencePane.js';
export {
  PROTECTED_MASK,
  PROTECTED_REASON_TEXT,
  ProtectedValue,
  type ProtectedReason,
  type ProtectedValueProps,
  type ProtectedVerdict,
} from './ProtectedValue.js';
export {
  EventInspector,
  treeEntries,
  type EventInspectorProps,
  type JsonTreeOptions,
} from './EventInspector.js';
