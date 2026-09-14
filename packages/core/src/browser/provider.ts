import { identifyExecutable, toChromeInstall } from './browser-resolver.js';
import { detectChrome } from './chrome-discovery.js';
import {
  BrowserCompatibilityError,
  BrowserInstallOfferDeclinedError,
  BrowserManagedInstallError,
  ChromeNotFoundError,
} from './errors.js';
import type { InstallOfferGateway } from './install-offer-gateway.js';
import type {
  BrowserRuntimeServices,
  BrowserSelection,
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

    // 1. Resolve identity.
    const requestedSelection = selectionFromLaunchOptions(opts) ?? this.selection;
    const resolution = await this.resolveWithInstallOffer(requestedSelection);
    if (resolution.status === 'unavailable') throw resolution.error;
    let installation = resolution.installation;

    // 2. Acquire managed ownership before anything else touches the tree, and
    //    hold this one reservation across both the probe and the task launch.
    const reservation = await this.acquireManagedUse(installation);
    let profile: ResolvedProfile | null = null;
    let profileOwned = false;

    try {
      // 3. Verify compatibility. The probe runs its own synthetic session under
      //    the reservation we already hold; it never acquires a second.
      await this.assertCompatible(installation);

      // 4. Create the requested profile.
      profile = await this.profileStore.resolve(opts.profile);
      profileOwned = profile.kind === 'ephemeral' && profile.createdNow;

      // 5. Re-stat the executable. If the binary changed while we were probing,
      //    the evidence describes a different file and must not be reused.
      installation = await this.confirmIdentity(installation);

      // 6. Launch.
      const ownership: LaunchOwnership =
        reservation === null ? { kind: 'external' } : { kind: 'managed', reservation };

      this.logger.info(
        {
          source: installation.requestedSelection.source,
          origin: installation.selectionOrigin,
          reason: installation.selectionReason,
          ownership: installation.ownership,
          browserVersion: installation.version,
        },
        `launching Chrome ${installation.version} from ${installation.canonicalPath}`,
      );

      const launched = await launchResolvedChrome(opts, installation, profile, ownership);

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
      await this.rollback(reservation, profile, profileOwned);
      throw error;
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
  private async assertCompatible(installation: ResolvedBrowserInstallation): Promise<void> {
    const result = await this.services.compatibility.check(installation, {
      profile: this.probeProfile,
      // Cached evidence satisfies a launch; only `browser check` forces a probe.
      fresh: false,
    });
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
  }

  /**
   * Re-reads the executable after probing and refuses stale evidence.
   *
   * An update that replaced the binary between the probe and the launch would
   * otherwise let evidence about the old build authorize the new one.
   */
  private async confirmIdentity(
    installation: ResolvedBrowserInstallation,
  ): Promise<ResolvedBrowserInstallation> {
    const current = await identifyExecutable(installation.canonicalPath, {
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
      return installation;
    }

    // The file changed underneath us: re-resolve, then re-verify against the
    // build that is actually there before any user navigation.
    const reresolved = await this.services.resolver.resolve(installation.requestedSelection);
    if (reresolved.status === 'unavailable') throw reresolved.error;
    await this.assertCompatible(reresolved.installation);
    return reresolved.installation;
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
            { err: error },
            'failed to remove the ephemeral profile after a failed startup',
          ),
        );
    }
    if (reservation !== null) {
      await reservation
        .markNeverSpawned()
        .catch((error: unknown) =>
          this.logger.warn(
            { err: error },
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
