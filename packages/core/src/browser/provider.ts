import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { identifyExecutable, toChromeInstall } from './browser-resolver.js';
import { detectChrome } from './chrome-discovery.js';
import {
  BrowserCompatibilityError,
  BrowserInstallOfferDeclinedError,
  BrowserLaunchError,
  BrowserManagedInstallError,
  BrowserProcessError,
  BrowserResolutionError,
  ChromeNotFoundError,
  ManagedCoordinationError,
} from './errors.js';
import type { InstallOfferGateway } from './install-offer-gateway.js';
import type {
  BrowserReadyRuntimeEvent,
  BrowserRuntimeServices,
  BrowserSelection,
  BrowserStartupFailedRuntimeEvent,
  BrowserStartupPhase,
  CompatibilityDecision,
  ProbeProfile,
  ResolvedBrowserInstallation,
} from './installation-types.js';
import { parseLaunchOptions, selectionFromLaunchOptions } from './launch-options.js';
import { launchResolvedChrome, type LaunchOwnership } from './launcher.js';
import type { OwnedManagedUseReservation } from './managed-coordination.js';
import type { ManagedInstallService } from './managed-install-types.js';
import { managedBrowsersRoot } from './paths.js';
import { LocalProfileStore } from './profile-store.js';
import { createLocalBrowserRuntimeServices } from './runtime-services.js';
import { LocalBrowserSession } from './session.js';
import type {
  BrowserProvider,
  BrowserSession,
  ChromeInstall,
  LaunchOptions,
  Logger,
  ProfileStore,
  ResolvedProfile,
} from './types.js';

/* eslint-disable @typescript-eslint/no-empty-function */
const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
/* eslint-enable @typescript-eslint/no-empty-function */

/**
 * Launches a local Chrome instance over CDP pipe transport.
 *
 * Startup follows one sequence for every caller — validate input, resolve
 * identity, acquire managed ownership when applicable, verify compatibility,
 * create the requested profile, re-stat the executable, launch — and rolls back
 * completely at whichever step fails. There is no readiness-bypass flag: a
 * caller cannot opt out of the compatibility gate.
 *
 * @example
 * const provider = new LocalBrowserProvider({ profileStore: new LocalProfileStore() });
 * const session = await provider.launch({ profile: { kind: 'ephemeral' } });
 */
export class LocalBrowserProvider implements BrowserProvider {
  private static offerInFlight: Promise<boolean> | null = null;
  private static offerUsed = false;
  private readonly profileStore: ProfileStore;
  private readonly logger: Logger;
  private readonly services: BrowserRuntimeServices;
  private readonly probeProfile: ProbeProfile;
  private readonly selection: BrowserSelection | undefined;
  private readonly installOfferGateway: InstallOfferGateway | null | undefined;
  private readonly installService: ManagedInstallService | undefined;
  private readonly identify: typeof identifyExecutable;
  private readonly spawnBrowser: typeof launchResolvedChrome;

  constructor(deps: {
    profileStore: ProfileStore;
    logger?: Logger;
    clock?: () => Date;
    /** Selection, compatibility, coordination, and managed state. */
    services?: BrowserRuntimeServices;
    /** Which capability set this provider's sessions require. */
    probeProfile?: ProbeProfile;
    /**
     * Per-invocation browser choice applied when a launch supplies none.
     *
     * It is a default, not an override: a caller that passes its own
     * `browserSelection` still wins, and nothing here is ever persisted.
     */
    selection?: BrowserSelection;
    installOfferGateway?: InstallOfferGateway | null;
    installService?: ManagedInstallService;
    /**
     * External boundary: reading a binary's identity off disk.
     *
     * Injected for the same reason {@link LocalBrowserCompatibilityService}
     * injects it — re-stat is a filesystem call, and a module-scope spy cannot
     * intercept the sibling call this class makes to it.
     */
    identify?: typeof identifyExecutable;
    /** External boundary: spawning the browser process. */
    launch?: typeof launchResolvedChrome;
  }) {
    this.profileStore = deps.profileStore;
    this.logger = deps.logger ?? noopLogger;
    this.services =
      deps.services ??
      createLocalBrowserRuntimeServices({ profileStore: deps.profileStore, logger: this.logger });
    this.probeProfile = deps.probeProfile ?? 'automation';
    this.selection = deps.selection;
    this.installOfferGateway =
      deps.installOfferGateway === undefined
        ? this.services.installOfferGateway
        : deps.installOfferGateway;
    this.installService = deps.installService ?? this.services.installService;
    this.identify = deps.identify ?? identifyExecutable;
    this.spawnBrowser = deps.launch ?? launchResolvedChrome;
  }

  /**
   * @inheritdoc
   *
   * Kept for callers that only want to know whether *some* browser exists.
   * Selection provenance comes from the resolver, not from here.
   */
  async detectChrome(): Promise<ChromeInstall | null> {
    const resolution = await this.services.resolver.resolve(this.selection);
    if (resolution.status === 'resolved') return toChromeInstall(resolution.installation);
    return detectChrome();
  }

  /**
   * Launches Chrome and returns a live BrowserSession.
   *
   * @throws {BrowserLaunchError} on invalid options or launch failure
   * @throws {BrowserResolutionError} when the selection names no usable browser
   * @throws {BrowserCompatibilityError} when the browser fails a required primitive
   */
  async launch(options: Partial<LaunchOptions>): Promise<BrowserSession> {
    const opts = parseLaunchOptions(options);

    // The startup phase is tracked rather than inferred from the error class:
    // the same class can be thrown from two steps (a resolution failure during
    // first resolve and during identity revalidation), and "which step were we
    // on?" is the fact an operator reading the log actually needs.
    let phase: BrowserStartupPhase = 'resolution';
    let reservation: OwnedManagedUseReservation | null = null;
    let profile: ResolvedProfile | null = null;
    let profileOwned = false;

    try {
      // 1. Resolve identity.
      const requestedSelection = selectionFromLaunchOptions(opts) ?? this.selection;
      const resolution = await this.resolveWithInstallOffer(requestedSelection);
      if (resolution.status === 'unavailable') throw resolution.error;
      let installation = resolution.installation;

      // 2. Acquire managed ownership before anything else touches the tree, and
      //    hold this one reservation across both the probe and the task launch.
      phase = 'reservation';
      reservation = await this.acquireManagedUse(installation);

      // 3. Verify compatibility. The probe runs its own synthetic session under
      //    the reservation we already hold; it never acquires a second.
      phase = 'compatibility';
      let decision = await this.assertCompatible(installation);

      // 4. Create the requested profile.
      phase = 'profile';
      profile = await this.profileStore.resolve(opts.profile);
      profileOwned = profile.kind === 'ephemeral' && profile.createdNow;

      // 5. Re-stat the executable. If the binary changed while we were probing,
      //    the evidence describes a different file and must not be reused — so
      //    the installation AND its decision are replaced together. Logging the
      //    pre-revalidation pair would name a build that never ran.
      phase = 'identity-revalidation';
      ({ installation, decision } = await this.confirmIdentity(installation, decision));

      // 6. Launch.
      phase = 'launch';
      const ownership: LaunchOwnership =
        reservation === null ? { kind: 'external' } : { kind: 'managed', reservation };

      this.logger.info(
        toLogPayload(readyEvent(installation, decision, this.probeProfile)),
        `launching Chrome ${installation.version}`,
      );

      const launched = await this.spawnBrowser(opts, installation, profile, ownership);

      // Ownership of the process, the profile, and the reservation transfers
      // into the session exactly once, here.
      return new LocalBrowserSession({
        launched,
        installation,
        profile,
        profileStore: this.profileStore,
        logger: this.logger,
      });
    } catch (error) {
      this.logStartupFailure(phase, error);
      await this.rollback(reservation, profile, profileOwned);
      throw error;
    }
  }

  /**
   * Records one safe projection of a startup refusal, before rollback.
   *
   * The original error is never touched: it propagates unchanged to the caller,
   * which is the surface that may legitimately render its message. What lands
   * in the durable operator log is the closed classification only.
   */
  private logStartupFailure(phase: BrowserStartupPhase, error: unknown): void {
    const event = startupFailedEvent(phase, error);
    if (event.failure_kind === 'launch' || event.failure_kind === 'process') {
      this.logger.error(toLogPayload(event), 'browser startup failed');
    } else {
      this.logger.warn(toLogPayload(event), 'browser startup refused');
    }
  }

  /** Offers installation only for an automatic, genuinely missing browser. */
  private async resolveWithInstallOffer(selection: BrowserSelection | undefined) {
    let resolution = await this.services.resolver.resolve(selection);
    if (resolution.status === 'resolved' || resolution.error.code !== 'missing') return resolution;
    const automatic = selection === undefined || selection.source === 'auto';
    const gateway = this.installOfferGateway;
    const installer = this.installService;
    if (!automatic || gateway === null || gateway === undefined || installer === undefined)
      return resolution;
    if (LocalBrowserProvider.offerUsed) return resolution;
    LocalBrowserProvider.offerInFlight ??= (async () => {
      const decision = await gateway.offer({
        destinationRoot: managedBrowsersRoot(),
        approximateBytes: 200 * 1024 * 1024,
      });
      LocalBrowserProvider.offerUsed = true;
      if (decision === null) throw new BrowserInstallOfferDeclinedError();
      const outcome = await installer.install({
        trigger: 'interactive-offer',
        consent: {
          granted: true,
          source: decision.source,
          grantedAt: new Date().toISOString(),
          destinationRoot: managedBrowsersRoot(),
          approximateBytes: 200 * 1024 * 1024,
          // A first install has no accepted build and replaces nothing: Stable
          // is resolved in-helper. Only an update names a build in advance.
          targetBuildId: null,
          replaces: null,
        },
      });
      if (outcome.status === 'installed' || outcome.status === 'already-installed') return true;
      if (outcome.status === 'cancelled') throw new BrowserInstallOfferDeclinedError();
      throw new BrowserManagedInstallError(outcome.error);
    })();
    const installed = await LocalBrowserProvider.offerInFlight.finally(() => {
      LocalBrowserProvider.offerInFlight = null;
    });
    if (installed) resolution = await this.services.resolver.resolve(selection);
    return resolution;
  }

  /** @internal Clears process-level offer state for isolated behavior tests. */
  static resetInstallOfferForTests(): void {
    LocalBrowserProvider.offerInFlight = null;
    LocalBrowserProvider.offerUsed = false;
  }

  /** Reserves the managed installation, or nothing at all for an external one. */
  private async acquireManagedUse(
    installation: ResolvedBrowserInstallation,
  ): Promise<OwnedManagedUseReservation | null> {
    if (installation.ownership !== 'managed' || installation.managedIdentity === null) return null;
    const reservation = await this.services.coordinator.reserveUse(installation.managedIdentity);
    return reservation as OwnedManagedUseReservation;
  }

  /**
   * Refuses the session before any user page can be opened.
   *
   * The refusal names each failing primitive rather than implying that a
   * version mismatch alone caused it — a build outside the tested pairing is the
   * normal case, not a fault.
   */
  private async assertCompatible(
    installation: ResolvedBrowserInstallation,
  ): Promise<CompatibilityDecision> {
    const decision = await this.services.compatibility.decide(installation, {
      profile: this.probeProfile,
      // Cached evidence satisfies a launch; only `browser check` forces a probe.
      fresh: false,
    });
    const result = decision.result;
    if (result.verdict.status === 'failed') {
      throw new BrowserCompatibilityError({
        failureClass: result.verdict.failureClass,
        profile: this.probeProfile,
        executablePath: installation.canonicalPath,
        version: installation.version,
        capabilities: result.capabilities,
        remediation: result.verdict.remediation,
      });
    }
    return decision;
  }

  /**
   * Re-reads the executable after probing and refuses stale evidence.
   *
   * An update that replaced the binary between the probe and the launch would
   * otherwise let evidence about the old build authorize the new one.
   */
  private async confirmIdentity(
    installation: ResolvedBrowserInstallation,
    decision: CompatibilityDecision,
  ): Promise<{
    readonly installation: ResolvedBrowserInstallation;
    readonly decision: CompatibilityDecision;
  }> {
    const current = await this.identify(installation.canonicalPath, {
      platform: installation.platform,
      architecture: installation.architecture,
    });
    if (current === null) {
      throw new ChromeNotFoundError({
        os: installation.platform,
        probed: [installation.canonicalPath],
      });
    }
    if (
      current.statFingerprint === installation.statFingerprint &&
      current.version === installation.version
    ) {
      return { installation, decision };
    }

    // The file changed underneath us: re-resolve, then re-verify against the
    // build that is actually there before any user navigation. The new decision
    // travels with the new installation — a caller holding one and logging the
    // other would describe a pairing that was never authorized.
    const reresolved = await this.services.resolver.resolve(installation.requestedSelection);
    if (reresolved.status === 'unavailable') throw reresolved.error;
    return {
      installation: reresolved.installation,
      decision: await this.assertCompatible(reresolved.installation),
    };
  }

  /**
   * Undoes exactly what this startup acquired.
   *
   * Only an ephemeral profile this call created is removed — a workflow or
   * explicit profile the user owns survives a failed startup untouched.
   */
  private async rollback(
    reservation: OwnedManagedUseReservation | null,
    profile: ResolvedProfile | null,
    profileOwned: boolean,
  ): Promise<void> {
    if (profile !== null && profileOwned) {
      await this.profileStore
        .cleanupEphemeral(profile.absolutePath)
        .catch((error: unknown) =>
          this.logger.warn(
            { error_class: errorClassOf(error) },
            'failed to remove the ephemeral profile after a failed startup',
          ),
        );
    }
    if (reservation !== null) {
      await reservation
        .markNeverSpawned()
        .catch((error: unknown) =>
          this.logger.warn(
            { error_class: errorClassOf(error) },
            'failed to release the managed reservation after a failed startup',
          ),
        );
    }
  }
}

/**
 * Per-run browser wiring for the CLI and agent factories.
 *
 * Every launch-capable path takes this instead of building its own provider, so
 * "the same source, path, and ownership everywhere" holds by construction
 * rather than by each factory remembering to agree.
 */
export interface BrowserRuntimeOptions {
  /** Shared services. Defaults to the local read-only composition. */
  readonly services?: BrowserRuntimeServices;
  /** Per-invocation choice. Ephemeral — never written to config. */
  readonly selection?: BrowserSelection;
  readonly profileStore?: ProfileStore;
  readonly logger?: Logger;
  readonly installOfferGateway?: InstallOfferGateway | null;
  readonly installService?: ManagedInstallService;
}

/**
 * Builds the provider every runtime factory should use.
 *
 * Construction is inert: no browser starts, no probe runs, no lock is taken,
 * and no update or download boundary is touched until a caller actually
 * launches.
 */
export function createSelectedBrowserProvider(opts: BrowserRuntimeOptions = {}): BrowserProvider {
  const logger = opts.logger ?? noopLogger;
  const profileStore = opts.profileStore ?? new LocalProfileStore({ logger });
  return new LocalBrowserProvider({
    profileStore,
    logger,
    services:
      opts.services ??
      createLocalBrowserRuntimeServices({
        profileStore,
        logger,
        ...(opts.installOfferGateway === undefined
          ? {}
          : { installOfferGateway: opts.installOfferGateway }),
        ...(opts.installService === undefined ? {} : { installService: opts.installService }),
      }),
    ...(opts.selection ? { selection: opts.selection } : {}),
    ...(opts.installOfferGateway === undefined
      ? {}
      : { installOfferGateway: opts.installOfferGateway }),
    ...(opts.installService === undefined ? {} : { installService: opts.installService }),
  });
}

// ---------------------------------------------------------------------------
// Runtime lifecycle projections
// ---------------------------------------------------------------------------

/**
 * Projects the launch that is about to happen into safe, durable evidence.
 *
 * Built from the *final* installation and the *final* decision so the event
 * always describes the binary that actually runs. The canonical path is hashed
 * rather than recorded: a run directory is local diagnostics, but a home
 * directory path in it identifies a person, and every question this event is
 * asked ("same binary as yesterday?", "which build?") is answered by the hash,
 * the basename, and the version.
 */
export function readyEvent(
  installation: ResolvedBrowserInstallation,
  decision: CompatibilityDecision,
  probeProfile: ProbeProfile,
): BrowserReadyRuntimeEvent {
  const result = decision.result;
  return {
    schema_version: 1,
    event: 'browser_ready',
    selection_source: installation.requestedSelection.source,
    selection_origin: installation.selectionOrigin,
    selection_reason: installation.selectionReason,
    ownership: installation.ownership,
    browser_version: installation.version,
    executable_basename: basename(installation.canonicalPath),
    executable_path_sha256: hashExecutablePath(installation.canonicalPath),
    executable_stat_fingerprint: installation.statFingerprint,
    driver_version: result.driverVersion,
    tested_build: result.testedBuild,
    probe_revision: result.probeRevision,
    probe_profile: probeProfile,
    compatibility_verdict: 'passed',
    // A `capability-checked` pairing is the steady state (plan §7.3/§10), so it
    // is ordinary INFO provenance here — never a warning nobody reads.
    pairing: result.verdict.status === 'passed' ? result.verdict.pairing : 'capability-checked',
    evidence_source: decision.evidenceSource,
    evidence_checked_at: result.checkedAt,
  };
}

/** SHA-256 over the normalized canonical path. Case-folded where the OS is. */
export function hashExecutablePath(canonicalPath: string): string {
  const normalized =
    process.platform === 'win32'
      ? canonicalPath.replaceAll('\\', '/').toLowerCase()
      : canonicalPath.replaceAll('\\', '/');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Projects a thrown startup error into closed, non-sensitive fields.
 *
 * Every branch reads only enumerated context off the real exported error class.
 * Nothing here touches `message`, `stack`, `args`, `lastStderr`, or a raw
 * `detail` string — those are exactly the fields that carry a launch command
 * line, a loader dump, or a filesystem path.
 */
export function startupFailedEvent(
  phase: BrowserStartupPhase,
  error: unknown,
): BrowserStartupFailedRuntimeEvent {
  const base = {
    schema_version: 1 as const,
    event: 'browser_startup_failed' as const,
    phase,
    error_class: errorClassOf(error),
  };
  if (error instanceof BrowserResolutionError) {
    return { ...base, failure_kind: 'resolution', resolution_code: error.code };
  }
  if (error instanceof ChromeNotFoundError) {
    return { ...base, failure_kind: 'resolution', resolution_code: 'missing' };
  }
  if (error instanceof BrowserCompatibilityError) {
    return {
      ...base,
      failure_kind: 'compatibility',
      compatibility_failure_class: error.context.failureClass,
      compatibility_profile: error.context.profile,
    };
  }
  if (error instanceof BrowserInstallOfferDeclinedError) {
    return { ...base, failure_kind: 'install-declined' };
  }
  if (error instanceof BrowserManagedInstallError) {
    return {
      ...base,
      failure_kind: 'managed-install',
      install_code: error.installError.code,
      install_phase: error.installError.phase,
    };
  }
  if (error instanceof ManagedCoordinationError) {
    return { ...base, failure_kind: 'coordination', coordination_reason: error.context.reason };
  }
  if (error instanceof BrowserLaunchError) {
    return { ...base, failure_kind: 'launch', launch_phase: error.context.phase };
  }
  if (error instanceof BrowserProcessError) {
    return {
      ...base,
      failure_kind: 'process',
      process_phase: error.context.phase,
      exit_proven: error.context.exitProven,
    };
  }
  return { ...base, failure_kind: 'unexpected' };
}

/** The class name alone — never the message, which is caller-facing prose. */
export function errorClassOf(error: unknown): string {
  if (error instanceof Error && typeof error.name === 'string' && error.name.length > 0) {
    return error.name;
  }
  return 'UnknownError';
}

/**
 * Widens a closed projection to the shape a {@link Logger} method accepts.
 *
 * The event types are interfaces, and an interface has no implicit index
 * signature, so this one copy is where that gap is bridged — rather than at
 * every emit site, or by loosening the event contracts themselves.
 */
function toLogPayload(event: object): Record<string, unknown> {
  return { ...event };
}
