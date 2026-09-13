/**
 * Browser installation contracts — selection, identity, managed state,
 * coordination, and compatibility.
 *
 * This module is deliberately type-only plus a handful of frozen constants: it
 * is the single vocabulary every browser-backed caller shares (provider,
 * recorder, doctor, CLI runtime factories), so an implementation living here
 * would pull a dependency into all of them.
 */

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Where a browser executable is expected to come from. */
export type BrowserSource = 'auto' | 'managed' | 'system';

/** What the caller asked for. Ephemeral per invocation, or read from config. */
export interface BrowserSelection {
  readonly source: BrowserSource;
  /** Absolute path. Legal only with source `system`. */
  readonly executablePath: string | null;
}

/**
 * Supplies the persisted selection. FEAT-045 owns the validated config
 * adapter; until then the default reader reports "no configured selection".
 */
export interface BrowserSelectionReader {
  read(): Promise<BrowserSelection | undefined>;
}

/** How a selection reached the resolver. */
export type SelectionOrigin = 'invocation' | 'config' | 'default';

/** Why the resolver picked the installation it picked. */
export type SelectionReason =
  | 'managed-preferred'
  | 'managed-explicit'
  | 'system-discovery'
  | 'custom-path';

// ---------------------------------------------------------------------------
// Executable identity
// ---------------------------------------------------------------------------

/** Canonical facts about one binary; the cache key material for evidence. */
export interface ExecutableIdentity {
  readonly canonicalPath: string;
  readonly version: string;
  readonly majorVersion: number;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  /** Size, mtime, and filesystem identity where the OS supplies it. */
  readonly statFingerprint: string;
}

/** A validated executable plus its provenance. Resolution is read-only. */
export interface ResolvedBrowserInstallation extends ExecutableIdentity {
  readonly ownership: 'managed' | 'external';
  readonly requestedSelection: BrowserSelection;
  readonly selectionOrigin: SelectionOrigin;
  readonly selectionReason: SelectionReason;
  readonly channel: 'stable' | 'beta' | 'dev' | 'canary' | 'chromium' | 'unknown';
  readonly managedIdentity: ManagedReadyRecord | null;
}

/** Closed set of reasons resolution can fail. */
export type BrowserResolutionErrorCode =
  | 'missing'
  | 'invalid-selection'
  | 'invalid-executable'
  | 'managed-state-invalid'
  | 'unsupported-platform'
  | 'operation-in-progress';

export type BrowserResolution =
  | { readonly status: 'resolved'; readonly installation: ResolvedBrowserInstallation }
  | { readonly status: 'unavailable'; readonly error: BrowserResolutionErrorLike };

/**
 * Structural view of the resolution failure. The concrete class lives in
 * `errors.ts`; typing the union structurally keeps this module free of it.
 */
export interface BrowserResolutionErrorLike extends Error {
  readonly code: BrowserResolutionErrorCode;
  readonly requestedSelection: BrowserSelection;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly remediation: string;
}

export interface BrowserResolver {
  resolve(override?: BrowserSelection): Promise<BrowserResolution>;
}

// ---------------------------------------------------------------------------
// Managed installation state
// ---------------------------------------------------------------------------

/** Platform identifiers Chrome for Testing publishes builds for. */
export type ManagedPlatform = 'linux' | 'mac' | 'mac_arm' | 'win32' | 'win64';

export const MANAGED_PLATFORMS: readonly ManagedPlatform[] = Object.freeze([
  'linux',
  'mac',
  'mac_arm',
  'win32',
  'win64',
]);

/** Prefix every managed child cache root carries. */
export const MANAGED_INSTALLATION_PREFIX = 'installation-';

/** One ready build, recorded relatively so a relocated data dir still resolves. */
export interface ManagedReadyRecord {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly browser: 'chrome';
  readonly platform: ManagedPlatform;
  readonly buildId: string;
  /** Exactly one `installation-<opaque-id>` segment. */
  readonly cacheRootRelative: string;
  /** Normalized, no `..`, never absolute. */
  readonly executableRelative: string;
  /** ISO timestamp. Provenance only — never compatibility evidence. */
  readonly verifiedAt: string;
}

export type ManagedReadySnapshot =
  | { readonly status: 'absent' }
  | { readonly status: 'ready'; readonly record: ManagedReadyRecord }
  | { readonly status: 'invalid'; readonly reason: string };

/**
 * Any `installation-*` child the ready pointer does not name.
 *
 * That single rule replaces candidate/previous bookkeeping, transaction
 * phases, and crash recovery: a candidate under construction is an orphan with
 * a live owner, an abandoned candidate and a superseded installation are
 * orphans with no owner, and none of them is ever selectable.
 */
export interface ManagedOrphan {
  readonly cacheRootRelative: string;
  readonly bytes: number;
  /** True when a live mutation lease names it. */
  readonly hasLiveOwner: boolean;
}

export interface ManagedInventory {
  readonly ready: ManagedReadySnapshot;
  readonly orphans: readonly ManagedOrphan[];
}

export interface ManagedStateReader {
  readReady(): Promise<ManagedReadySnapshot>;
  /** Read-only. Deletes nothing — explicit install/update collects orphans. */
  readInventory(): Promise<ManagedInventory>;
}

// ---------------------------------------------------------------------------
// Coordination
// ---------------------------------------------------------------------------

/** A process plus the creation identity that distinguishes it from PID reuse. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly startToken: string;
}

/** Whether a recorded process is still running. `unknown` fails conservatively. */
export type LivenessVerdict = 'alive' | 'dead' | 'unknown';

/** Cross-platform liveness boundary, injected so tests can drive every verdict. */
export interface ProcessLivenessProbe {
  identify(pid: number): Promise<ProcessIdentity | null>;
  check(identity: ProcessIdentity): Promise<LivenessVerdict>;
}

export type ManagedUsePhase = 'starting' | 'running' | 'stopping';

/** A shared claim held from resolution through actual browser process exit. */
export interface ManagedUseReservation {
  readonly id: string;
  readonly installationId: string;
  attachChild(child: ProcessIdentity): Promise<void>;
  releaseAfterExit(): Promise<void>;
}

/** The exclusive mutation claim. Names the exact path it may write. */
export interface ManagedMutationLease {
  readonly operationId: string;
  readonly candidateRootRelative: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export interface ManagedCoordinator {
  reserveUse(expected: ManagedReadyRecord): Promise<ManagedUseReservation>;
  claimMutation(operationId: string, candidateRootRelative: string): Promise<ManagedMutationLease>;
  /** Consulted by `config data-dir` before relocating the data tree. */
  hasActiveUse(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Driver compatibility descriptor
// ---------------------------------------------------------------------------

/** Which caller a capability row is required by. */
export type ProbeProfile = 'automation' | 'recorder';

export type CapabilityId =
  | 'pipe-version'
  | 'runtime-evaluate'
  | 'dom-handles'
  | 'click-replace'
  | 'frame-token'
  | 'popup-session'
  | 'recorder-binding'
  | 'recorder-preload'
  | 'recorder-page-domain';

export interface CapabilityRequirement {
  readonly id: CapabilityId;
  /** Rendered verbatim by `browser check`. */
  readonly why: string;
  readonly requiredBy: readonly ProbeProfile[];
  readonly dependsOn: readonly CapabilityId[];
}

export interface DriverCompatibilityDescriptor {
  readonly driverVersion: string;
  /** A baseline, not a floor and not a target. */
  readonly testedBuild: string;
  /** Bumped whenever the probe implementation changes. */
  readonly probeRevision: number;
  readonly capabilities: readonly CapabilityRequirement[];
  readonly cftPlatforms: Readonly<Record<string, ManagedPlatform>>;
  isSupportedHost(platform: NodeJS.Platform, arch: string): boolean;
}

// ---------------------------------------------------------------------------
// Compatibility evidence
// ---------------------------------------------------------------------------

export type ProbeFailureClass =
  | 'missing-runtime-libraries'
  | 'capability-failure'
  | 'launch-environment';

export interface CapabilityEvidence {
  readonly capability: CapabilityId;
  readonly status: 'passed' | 'failed' | 'not-run';
  /** `not-run` names the prerequisite that failed. */
  readonly reason: string | null;
}

export interface CompatibilityResult {
  readonly schemaVersion: 1;
  readonly identity: ExecutableIdentity;
  readonly driverVersion: string;
  readonly testedBuild: string;
  readonly probeRevision: number;
  readonly capabilityTableHash: string;
  readonly profile: ProbeProfile;
  readonly checkedAt: string;
  readonly capabilities: readonly CapabilityEvidence[];
  readonly verdict:
    | { readonly status: 'passed'; readonly pairing: 'tested' | 'capability-checked' }
    | {
        readonly status: 'failed';
        readonly failureClass: ProbeFailureClass;
        readonly remediation: string;
      };
}

/** What `browser use` and doctor read: evidence, or an honest `unverified`. */
export type CompatibilityEvidenceState =
  | { readonly state: 'unverified' }
  | { readonly state: 'evidence'; readonly result: CompatibilityResult };

export interface CompatibilityCheckOptions {
  readonly profile: ProbeProfile;
  /** True always bypasses a cached success. */
  readonly fresh: boolean;
  readonly signal?: AbortSignal;
}

export interface BrowserCompatibilityService {
  check(
    installation: ResolvedBrowserInstallation,
    options: CompatibilityCheckOptions,
  ): Promise<CompatibilityResult>;
  /** Never launches. */
  readCached(
    installation: ResolvedBrowserInstallation,
    profile: ProbeProfile,
  ): Promise<CompatibilityEvidenceState>;
}

/** The composed local seam every browser-backed caller receives. */
export interface BrowserRuntimeServices {
  readonly resolver: BrowserResolver;
  readonly compatibility: BrowserCompatibilityService;
  readonly coordinator: ManagedCoordinator;
  readonly managedState: ManagedStateReader;
}
