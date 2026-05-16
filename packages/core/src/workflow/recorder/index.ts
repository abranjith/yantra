/**
 * Public barrel for the recorder module.
 *
 * Exports:
 *   - `RecordingSession` — the main session orchestrator
 *   - `FileSystemRecordingStore` / `RecordingStore` — persistence layer
 *   - `DefaultCaptureRedactor` / `CaptureRedactor` — value redaction
 *   - `IdleWatcher` — idle timeout management
 *   - `assembleDraft` / `computeDwellPerPage` — draft building utilities
 *   - Session event types (for CLI consumption in FEAT-012)
 *
 * NOT exported (by design):
 *   - `RawCapturedActionInput` — internal pre-redaction type, must not cross module boundary
 *   - In-page overlay types — browser-context only
 *   - `PopupHandler` — internal to session
 */

export { RecordingSession } from './session.js';
export type { RecordingHandle, RecordingStartOptions } from './session.js';

export { FileSystemRecordingStore } from './store.js';
export type { RecordingStore } from './store.js';

export { DefaultCaptureRedactor, defangAttrValue } from './redactor.js';
export type { CaptureRedactor } from './redactor.js';

export { IdleWatcher, DEFAULT_IDLE_TIMEOUT_MS } from './idle-watcher.js';

export { assembleDraft, computeDwellPerPage } from './draft-builder.js';
export type { AssembleDraftOptions } from './draft-builder.js';

export { normalizeCandidateChain } from './candidate-resolver.js';
export type { RawInPageCandidate } from './candidate-resolver.js';

// Session event types (consumed by FEAT-012 CLI renderer)
export type {
  AbortCause,
  CaptureEmittedEvent,
  IdleTimeoutPromptEvent,
  NavigationCapturedEvent,
  PopupAttachedEvent,
  PopupClosedEvent,
  RecordingAbortedEvent,
  RecordingDegradedEvent,
  RecordingSessionEvent,
  RecordingStartedEvent,
  RecordingState,
  RecordingStoppedEvent,
  UnrecordedFrameEvent,
} from './types.js';
