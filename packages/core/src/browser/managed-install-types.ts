/** Contracts for the explicit, consented Chrome-for-Testing installer. */
import { z } from 'zod';

import type {
  CompatibilityEvidenceState,
  CompatibilityResult,
  ManagedMutationLease,
  ManagedReadyRecord,
  ManagedPlatform,
  ProbeFailureClass,
} from './installation-types.js';

export type ConsentSource =
  | 'cli-accept-flag'
  | 'cli-prompt'
  | 'interactive-offer'
  | 'cli-update-prompt';

/**
 * One acquisition the user accepted.
 *
 * There is deliberately one consent type rather than an install record and an
 * update record: replacing a browser and installing the first one are the same
 * decision about the same destination, and a second grammar for it would be a
 * second place for "what did the user actually agree to?" to drift.
 *
 * `targetBuildId` is what makes consent verifiable. An update resolves Stable
 * once, *before* asking, and the service refuses a record that names a
 * different build — so the build a user accepted is the build that lands even
 * if upstream publishes a new Stable mid-operation.
 */
export interface DownloadConsentRecord {
  readonly granted: true;
  readonly source: ConsentSource;
  readonly grantedAt: string;
  readonly destinationRoot: string;
  readonly approximateBytes: number;
  /** The exact accepted build. `null` on a first install, which resolves Stable in-helper. */
  readonly targetBuildId: string | null;
  /** The build being replaced. `null` on a first install — nothing is replaced. */
  readonly replaces: string | null;
}
export type ManagedInstallTrigger = 'explicit-command' | 'interactive-offer';
export type ManagedInstallPhase =
  | 'preflight'
  | 'collecting-orphans'
  | 'resolving-stable'
  | 'downloading'
  | 'extracting'
  | 'finalizing'
  | 'verifying'
  | 'publishing';
export interface ManagedInstallProgress {
  readonly phase: ManagedInstallPhase;
  readonly buildId: string | null;
  readonly downloadedBytes?: number;
  readonly totalBytes?: number | null;
  readonly percent?: number;
  readonly resumable: false;
  readonly interruptible: boolean;
}
export interface ManagedInstallRequest {
  readonly trigger: ManagedInstallTrigger;
  readonly consent: DownloadConsentRecord;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ManagedInstallProgress) => void;
  readonly deadlineMs?: number;
}
export interface OrphanCollectionReport {
  readonly attempted: number;
  readonly deleted: number;
  readonly bytesReclaimed: number;
  readonly skippedLiveOwner: number;
  readonly failed: readonly { readonly cacheRootRelative: string; readonly reason: string }[];
}
export interface ManagedSelectionNotice {
  readonly configuredSource: 'auto' | 'managed' | 'system' | 'unknown';
  readonly selectsThisInstallation: boolean;
  readonly command: string | null;
}
export type ManagedInstallFailureCode =
  | 'unsupported-platform'
  | 'operation-in-progress'
  | 'consent-required'
  | 'helper-unavailable'
  | 'proxy-unsupported-runtime'
  | 'archive-tool-missing'
  | 'insufficient-disk-space'
  | 'insufficient-permissions'
  | 'metadata-unavailable'
  | 'proxy-failure'
  | 'network-failure'
  | 'extraction-failure'
  | 'helper-crashed'
  | 'timed-out'
  | 'verification-failure'
  | 'compatibility-failure'
  | 'publication-failure';
export interface ManagedInstallError {
  readonly code: ManagedInstallFailureCode;
  readonly phase: ManagedInstallPhase;
  readonly remediation: string;
  readonly detail: string;
  readonly probeFailure?: ProbeFailureClass;
  readonly searchedPaths?: readonly string[];
  readonly proxyHost?: string;
  readonly retainedOrphan: string | null;
}
export type ManagedInstallOutcome =
  | {
      readonly status: 'installed';
      readonly record: ManagedReadyRecord;
      readonly executablePath: string;
      readonly compatibility: CompatibilityResult;
      readonly orphans: OrphanCollectionReport;
      readonly selection: ManagedSelectionNotice;
    }
  | {
      readonly status: 'already-installed';
      readonly record: ManagedReadyRecord;
      readonly executablePath: string;
      readonly compatibility: CompatibilityEvidenceState;
      readonly orphans: OrphanCollectionReport;
      readonly updateCommand: 'yantra browser update';
    }
  | {
      readonly status: 'cancelled';
      readonly at: ManagedInstallPhase;
      readonly retainedOrphan: string | null;
    }
  | { readonly status: 'failed'; readonly error: ManagedInstallError };
export interface ManagedInstallService {
  install(request: ManagedInstallRequest): Promise<ManagedInstallOutcome>;
  collectOrphans(options?: { readonly bestEffort?: boolean }): Promise<OrphanCollectionReport>;
}

// ---------------------------------------------------------------------------
// The single acquisition path
// ---------------------------------------------------------------------------

/**
 * One consented acquisition, from orphan collection through atomic publication.
 *
 * `install` and `update` are the same transaction with different preconditions,
 * so they share one implementation rather than two that must be kept in step.
 * The candidate is not named here: the lease already names the exact child
 * cache root its owner is authorized to write, and deriving the path from the
 * authorization is what keeps them from disagreeing.
 */
export interface ManagedAcquisitionOptions {
  readonly lease: ManagedMutationLease;
  /** The exact accepted build, or `null` to let the helper resolve Stable (first install). */
  readonly targetBuildId: string | null;
  /** The build being replaced, for the outcome. `null` on a first install. */
  readonly previousBuildId: string | null;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ManagedInstallProgress) => void;
  readonly deadlineMs?: number;
  /**
   * Re-verified immediately before publication; throw to abort.
   *
   * This is where update closes the window in which a browser starts *during*
   * the download. Install passes nothing, so its behavior is unchanged.
   */
  readonly beforePublish?: () => Promise<void>;
}

export type ManagedAcquisitionResult =
  | {
      readonly status: 'published';
      readonly record: ManagedReadyRecord;
      readonly executablePath: string;
      readonly compatibility: CompatibilityResult;
      readonly orphans: OrphanCollectionReport;
      readonly selection: ManagedSelectionNotice;
      readonly previousBuildId: string | null;
    }
  | {
      readonly status: 'cancelled';
      readonly at: ManagedInstallPhase;
      readonly retainedOrphan: string | null;
    }
  | { readonly status: 'failed'; readonly error: ManagedInstallError };

/**
 * The acquisition seam `update` calls instead of building a second one.
 *
 * A boundary test asserts that nothing else in `src/browser` spawns an
 * acquisition helper, because a second path would be invisible until the two
 * disagreed about verification or publication.
 */
export interface ManagedAcquisitionService {
  acquireAndPublish(options: ManagedAcquisitionOptions): Promise<ManagedAcquisitionResult>;
}
export interface ManagedInstallPolicy {
  readonly wholeOperationMs: number;
  readonly metadataMs: number;
  readonly stallMs: number;
  readonly cancelAckMs: number;
  readonly finalizeGraceMs: number;
  readonly treeExitMs: number;
  readonly requiredFreeBytes: number;
  readonly progressIntervalMs: number;
}
export const DEFAULT_MANAGED_INSTALL_POLICY: ManagedInstallPolicy = Object.freeze({
  wholeOperationMs: 15 * 60_000,
  metadataMs: 30_000,
  stallMs: 60_000,
  cancelAckMs: 3_000,
  finalizeGraceMs: 60_000,
  treeExitMs: 10_000,
  requiredFreeBytes: 750 * 1024 * 1024,
  progressIntervalMs: 500,
});

/**
 * What the helper was asked to do.
 *
 * `resolve` answers "which build is Stable, and can it be downloaded?" and
 * exits. It creates no directory, writes no file, and never calls `install()`.
 */
export type HelperMode = 'install' | 'resolve';

/**
 * Argv contract for the owned acquisition helper.
 *
 * `protocolVersion` went 1 -> 2 with `mode` rather than making the field
 * optional. Parent and helper always ship from the same `dist/`, a mismatch
 * already means `helper-unavailable`, and an optional field would let a stale
 * helper silently perform an install when a resolve was requested.
 */
export const HelperRequestSchema = z
  .object({
    protocolVersion: z.literal(2),
    mode: z.enum(['install', 'resolve']),
    operationId: z.string().min(1),
    browser: z.literal('chrome'),
    platform: z.enum(['linux', 'mac', 'mac_arm', 'win32', 'win64']),
    cacheDir: z.string().min(1).nullable(),
    buildId: z.string().min(1).nullable(),
    progressIntervalMs: z.number().int().positive(),
  })
  // One grammar for "which fields does this mode permit", enforced where the
  // request is parsed rather than re-checked by each side.
  .superRefine((value, ctx) => {
    if (value.mode === 'resolve' && value.cacheDir !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cacheDir'],
        message: 'resolve mode must not be given a cache directory: it writes nothing',
      });
    }
    if (value.mode === 'install' && value.cacheDir === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cacheDir'],
        message: 'install mode requires the candidate cache directory it may write',
      });
    }
  });
export type HelperRequest = z.infer<typeof HelperRequestSchema> & {
  readonly platform: ManagedPlatform;
};
const phase = z.enum([
  'preflight',
  'collecting-orphans',
  'resolving-stable',
  'downloading',
  'extracting',
  'finalizing',
  'verifying',
  'publishing',
]);
export const HelperMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ready'),
    protocolVersion: z.literal(2),
    nodeVersion: z.string(),
    envProxyRequested: z.boolean(),
  }),
  z.object({ kind: z.literal('resolved'), buildId: z.string().min(1) }),
  // Resolve mode's single answer. It carries `artifactAvailable` because
  // "Stable is 153" and "153 can actually be downloaded for this platform" are
  // different facts, and an availability report that conflates them is wrong.
  z.object({
    kind: z.literal('availability'),
    buildId: z.string().min(1),
    artifactAvailable: z.boolean(),
  }),
  z.object({ kind: z.literal('phase'), phase, interruptible: z.boolean() }),
  z.object({
    kind: z.literal('progress'),
    downloadedBytes: z.number().nonnegative(),
    totalBytes: z.number().nonnegative().nullable(),
  }),
  z.object({ kind: z.literal('cancel-ack') }),
  z.object({
    kind: z.literal('result'),
    buildId: z.string().min(1),
    executableRelative: z.string().min(1),
  }),
  z.object({
    kind: z.literal('error'),
    code: z.enum([
      'unsupported-platform',
      'metadata-unavailable',
      'proxy-failure',
      'network-failure',
      'extraction-failure',
      'helper-crashed',
      'timed-out',
    ]),
    detail: z.string(),
  }),
]);
export type HelperMessage = z.infer<typeof HelperMessageSchema>;
export const ParentMessageSchema = z.object({ kind: z.literal('cancel') });
