/**
 * Contracts for the product's only update-check surface.
 *
 * `yantra browser update` is the one place in Yantra that ever asks whether a
 * newer Chrome exists. Nothing here records that a check happened: there is
 * deliberately no `lastCheckedAt` field, no availability cache, and no config
 * key, because a stored timestamp is the seed of the background-check feature
 * the plan forbids outright.
 *
 * This module adds only what update needs on top of FEAT-043's managed-state
 * and coordination contracts and FEAT-044's acquisition types. In particular
 * the failure taxonomy *extends* {@link ManagedInstallFailureCode} rather than
 * restating it: there is one managed-acquisition failure taxonomy, not two.
 */

import type {
  CompatibilityResult,
  ManagedReadyRecord,
  ManagedReadySnapshot,
} from './installation-types.js';
import type {
  DownloadConsentRecord,
  ManagedInstallFailureCode,
  ManagedInstallPhase,
  ManagedInstallProgress,
  ManagedSelectionNotice,
  OrphanCollectionReport,
} from './managed-install-types.js';

// ---------------------------------------------------------------------------
// Stable resolution
// ---------------------------------------------------------------------------

/**
 * One metadata answer, never cached to disk.
 *
 * `artifactAvailable` is separate from `buildId` because "Stable is 153" and
 * "153 has a downloadable artifact for this platform" are different facts, and
 * an availability report that conflates them tells the user the wrong thing.
 */
export interface StableBuild {
  readonly buildId: string;
  readonly platform: ManagedReadyRecord['platform'];
  /** ISO. In-memory provenance for this invocation only — never persisted. */
  readonly resolvedAt: string;
  readonly artifactAvailable: boolean;
}

export type StableResolution =
  | { readonly status: 'resolved'; readonly build: StableBuild }
  | { readonly status: 'unavailable'; readonly error: ManagedUpdateError };

export interface StableResolutionService {
  /** Metadata only. Never downloads, never writes, never takes a lease. */
  resolveStable(options?: {
    readonly signal?: AbortSignal;
    /** Defaults to `ManagedInstallPolicy.metadataMs`. */
    readonly deadlineMs?: number;
  }): Promise<StableResolution>;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * A closed union over "what is installed" versus "what is available".
 *
 * `installed-newer` exists because a silent downgrade is forbidden: it reports
 * both identities, proposes nothing, and is a success in both modes.
 *
 * `metadata-unavailable` keeps the local snapshot attached on purpose. An
 * unresolvable Stable is an *update* failure only — the recorded pointer, the
 * evidence cache, and every launch path are untouched, and the installed
 * browser stays fully usable offline. Reporting the failure without the
 * installation it did not affect would imply otherwise.
 */
export type UpdateComparison =
  | {
      readonly state: 'no-installation';
      readonly available: StableBuild;
      readonly installCommand: 'yantra browser install';
    }
  | {
      readonly state: 'up-to-date';
      readonly installed: ManagedReadyRecord;
      readonly available: StableBuild;
    }
  | {
      readonly state: 'update-available';
      readonly installed: ManagedReadyRecord;
      readonly available: StableBuild;
    }
  | {
      readonly state: 'installed-newer';
      readonly installed: ManagedReadyRecord;
      readonly available: StableBuild;
    }
  | {
      readonly state: 'metadata-unavailable';
      readonly installed: ManagedReadySnapshot;
      readonly error: ManagedUpdateError;
    };

// ---------------------------------------------------------------------------
// Availability report
// ---------------------------------------------------------------------------

/** What `--dry-run` renders: one local snapshot plus one metadata call, owning nothing. */
export interface ManagedUpdateAvailability {
  readonly comparison: UpdateComparison;
  readonly managedRoot: string;
  readonly driver: { readonly version: string; readonly testedBuild: string };
  /** A live mutation lease exists. Reported as local state, never acted on. */
  readonly concurrentOperation: boolean;
  /** Reported so the user knows a replacement would refuse. Never blocks this report. */
  readonly activeManagedRun: boolean;
  readonly nextCommand: string | null;
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/** Local preconditions, answered without a metadata call, a lease, or a launch. */
export type ManagedUpdatePreflight =
  | { readonly status: 'ready'; readonly record: ManagedReadyRecord }
  | { readonly status: 'refused'; readonly error: ManagedUpdateError };

export interface ManagedUpdateRequest {
  /** Names the exact target build in `targetBuildId` and the installed one in `replaces`. */
  readonly consent: DownloadConsentRecord;
  /** Resolved once, before consent. Never re-resolved after. */
  readonly target: StableBuild;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ManagedInstallProgress) => void;
  readonly deadlineMs?: number;
}

export type ManagedUpdateOutcome =
  | {
      readonly status: 'replaced';
      readonly previousBuildId: string;
      readonly record: ManagedReadyRecord;
      readonly executablePath: string;
      readonly compatibility: CompatibilityResult;
      readonly orphans: OrphanCollectionReport;
      readonly selection: ManagedSelectionNotice;
    }
  | {
      readonly status: 'up-to-date';
      readonly record: ManagedReadyRecord;
      readonly available: StableBuild;
    }
  | {
      readonly status: 'installed-newer';
      readonly record: ManagedReadyRecord;
      readonly available: StableBuild;
    }
  | {
      readonly status: 'cancelled';
      readonly at: ManagedInstallPhase;
      readonly retainedOrphan: string | null;
      /** The installation that kept working. */
      readonly record: ManagedReadyRecord;
    }
  | {
      readonly status: 'failed';
      readonly error: ManagedUpdateError;
      /** Proves the prior installation survived. */
      readonly record: ManagedReadySnapshot;
    };

export interface ManagedUpdateService {
  /** Metadata + local comparison only. No lease, no mutation, no download. */
  checkAvailability(): Promise<ManagedUpdateAvailability>;
  /**
   * Local preconditions only, so the mutation flow can refuse *before* paying
   * for a metadata call. Detecting a running browser after a 200 MB download is
   * a wasted download.
   */
  preflightMutation(): Promise<ManagedUpdatePreflight>;
  /** The mutation flow's single resolution, taken once before consent. */
  resolveTarget(signal?: AbortSignal): Promise<StableResolution>;
  /** Consented replacement. Refuses with no managed installation or a live managed run. */
  update(request: ManagedUpdateRequest): Promise<ManagedUpdateOutcome>;
}

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------

/**
 * FEAT-044's codes, verbatim, plus exactly two update-only ones.
 *
 * Reusing the install taxonomy is the point: an extraction failure during a
 * replacement is the same failure with the same repair as one during a first
 * install, and a second enum would let the two drift.
 */
export type ManagedUpdateFailureCode =
  | ManagedInstallFailureCode
  /** Update requires an existing installation; directs to `yantra browser install`. */
  | 'no-managed-installation'
  /** A managed browser is running. Stop it and retry — it is never terminated. */
  | 'managed-run-active'
  /** Consent names a build other than the one that was resolved. */
  | 'consent-build-mismatch';

export interface ManagedUpdateError {
  readonly code: ManagedUpdateFailureCode;
  readonly phase: ManagedInstallPhase | 'comparing';
  /** One supported repair, rendered verbatim. */
  readonly remediation: string;
  /** Sanitized: never raw helper stderr and never an archive command line. */
  readonly detail: string;
  /** Credentials stripped. */
  readonly proxyHost?: string;
  /** PIDs holding the installation open, for `managed-run-active`. */
  readonly activeOwnerPids?: readonly number[];
  readonly retainedOrphan: string | null;
}

/** Builds a typed update failure. The one constructor, so no field is forgotten. */
export function updateFailure(
  code: ManagedUpdateFailureCode,
  phase: ManagedUpdateError['phase'],
  remediation: string,
  detail: string,
  extra: Partial<ManagedUpdateError> = {},
): ManagedUpdateError {
  return { code, phase, remediation, detail, retainedOrphan: null, ...extra };
}
