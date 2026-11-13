/**
 * Run-view reads for the Yantra app (FEAT-066): the public-artifact gate, the
 * Ledger, the per-item run-result view, bounded readers and JSONL windows.
 */

export {
  ArtifactAccessError,
  LedgerCursorError,
  RunNotFoundError,
  RunViewError,
  type ArtifactAccessCode,
} from './errors.js';
export {
  NODE_ARTIFACT_GATE_FS,
  resolvePublicArtifact,
  type ArtifactGateFs,
  type PublicArtifact,
  type ResolveArtifactOptions,
} from './artifact-gate.js';
export {
  ACTIVE_SCAN_CAP,
  FILE_SCAN_CAP,
  NODE_LEDGER_FS,
  START_SLACK_MS,
  compareNewestFirst,
  decodeLedgerCursor,
  encodeLedgerCursor,
  queryRunLedger,
  runIdStartMs,
  type ActiveRun,
  type LedgerFs,
  type LedgerKey,
  type LedgerQuery,
  type LedgerResult,
  type RunLedgerDeps,
} from './ledger.js';
export {
  NODE_BOUNDED_READ_FS,
  readCapped,
  readHead,
  readTail,
  type BoundedReadFs,
  type CappedRead,
} from './bounded-read.js';
export {
  NODE_INVENTORY_FS,
  listRunArtifacts,
  type InventoryFs,
  type RunInventory,
} from './inventory.js';
export {
  TERMINAL_TAIL_BYTES,
  boundedText,
  readTerminalReason,
  type TerminalManifestFields,
} from './terminal-reason.js';
export {
  OUTPUTS_CAP_BYTES,
  enforceViewSize,
  leaseLiveState,
  normalizeManifest,
  readRunResult,
  type LiveState,
  type NormalizedManifest,
  type RunResultDeps,
} from './run-result.js';
