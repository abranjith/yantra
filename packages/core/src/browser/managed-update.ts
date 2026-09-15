/**
 * The product's only update surface.
 *
 * Two modes, and the boundary between them is what each is allowed to do:
 * {@link LocalManagedUpdateService.checkAvailability} reads local state and
 * makes one metadata call, owning nothing; {@link LocalManagedUpdateService.update}
 * replaces the single installation under an exclusive lease with recorded
 * consent naming the exact build.
 *
 * There is no transaction phase machine and no recovery routine here, by
 * design. The disjoint-child layout plus one atomically published pointer makes
 * every interrupted state the same state: any `installation-*` child the
 * pointer does not name is an orphan, a killed operation simply leaves one, and
 * the next explicit `install`/`update` collects it. The user never sees a "your
 * last update did not finish" state because there is nothing they could do
 * about it and nothing unsafe about it.
 */

import { randomUUID } from 'node:crypto';

import { DRIVER_COMPATIBILITY } from './driver-compatibility.js';
import { ManagedCoordinationError } from './errors.js';
import {
  MANAGED_INSTALLATION_PREFIX,
  type BrowserSelectionReader,
  type DriverCompatibilityDescriptor,
  type ManagedCoordinator,
  type ManagedMutationLease,
  type ManagedStateReader,
} from './installation-types.js';
import { compareManagedBuild, nextCommandFor } from './managed-availability.js';
import type { ManagedAcquisitionService, ManagedInstallError } from './managed-install-types.js';
import { ManagedInstallException } from './managed-preflight.js';
import {
  updateFailure,
  type ManagedUpdateAvailability,
  type ManagedUpdateError,
  type ManagedUpdateOutcome,
  type ManagedUpdatePreflight,
  type ManagedUpdateRequest,
  type ManagedUpdateService,
  type StableResolution,
  type StableResolutionService,
} from './managed-update-types.js';
import { managedBrowsersRoot } from './paths.js';
import type { Logger } from './types.js';

/** Reads the PIDs holding the installation open, when the coordinator can name them. */
interface ActiveUseReporter {
  activeUseOwners?(): Promise<readonly number[]>;
}

export interface ManagedUpdateDeps {
  readonly state: ManagedStateReader;
  readonly coordinator: ManagedCoordinator & ActiveUseReporter;
  /** FEAT-044's transaction. Update calls it; it never builds a second one. */
  readonly acquisition: ManagedAcquisitionService;
  readonly availability: StableResolutionService;
  readonly selectionReader?: BrowserSelectionReader;
  readonly descriptor?: DriverCompatibilityDescriptor;
  readonly root?: () => string;
  readonly id?: () => string;
  readonly logger?: Logger;
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export class LocalManagedUpdateService implements ManagedUpdateService {
  private readonly state: ManagedStateReader;
  private readonly coordinator: ManagedCoordinator & ActiveUseReporter;
  private readonly acquisition: ManagedAcquisitionService;
  private readonly availability: StableResolutionService;
  private readonly descriptor: DriverCompatibilityDescriptor;
  private readonly root: () => string;
  private readonly id: () => string;
  private readonly logger: Logger;

  constructor(deps: ManagedUpdateDeps) {
    this.state = deps.state;
    this.coordinator = deps.coordinator;
    this.acquisition = deps.acquisition;
    this.availability = deps.availability;
    this.descriptor = deps.descriptor ?? DRIVER_COMPATIBILITY;
    this.root = deps.root ?? managedBrowsersRoot;
    this.id = deps.id ?? randomUUID;
    this.logger = deps.logger ?? noopLogger;
  }

  /**
   * @inheritdoc
   *
   * Takes no lease and no reservation. A running managed browser and a live
   * mutation are *reported* as local state, never acted on and never a reason
   * to refuse — asking whether a newer Chrome exists is not a mutation, and
   * blocking it on one would be a refusal with nothing to protect.
   */
  async checkAvailability(): Promise<ManagedUpdateAvailability> {
    const [inventory, activeManagedRun, resolution] = await Promise.all([
      this.state.readInventory(),
      this.coordinator.hasActiveUse().catch(() => false),
      this.availability.resolveStable(),
    ]);
    const concurrentOperation = inventory.orphans.some((orphan) => orphan.hasLiveOwner);

    const comparison =
      resolution.status === 'resolved'
        ? compareManagedBuild(inventory.ready, resolution.build)
        : // The local snapshot rides along: an unresolvable Stable is an update
          // failure only, and the installed browser is still fully usable offline.
          ({
            state: 'metadata-unavailable',
            installed: inventory.ready,
            error: resolution.error,
          } as const);

    this.logger.info(
      {
        verdict: comparison.state,
        installedBuildId:
          inventory.ready.status === 'ready' ? inventory.ready.record.buildId : null,
        availableBuildId: resolution.status === 'resolved' ? resolution.build.buildId : null,
        concurrentOperation,
        activeManagedRun,
      },
      'managed browser availability checked',
    );

    return {
      comparison,
      managedRoot: this.root(),
      driver: {
        version: this.descriptor.driverVersion,
        testedBuild: this.descriptor.testedBuild,
      },
      concurrentOperation,
      activeManagedRun,
      nextCommand: nextCommandFor(comparison),
    };
  }

  /** @inheritdoc */
  async preflightMutation(): Promise<ManagedUpdatePreflight> {
    const ready = await this.state.readReady();
    if (ready.status !== 'ready') {
      return {
        status: 'refused',
        error: updateFailure(
          'no-managed-installation',
          'preflight',
          'Run `yantra browser install` to install the managed browser first.',
          ready.status === 'invalid'
            ? `There is no usable managed installation to replace: ${ready.reason}.`
            : 'There is no managed installation to replace.',
        ),
      };
    }

    // Before any metadata call, deliberately: detecting a running browser after
    // a 200 MB transfer is a wasted download.
    if (await this.coordinator.hasActiveUse()) {
      return { status: 'refused', error: await this.busyError() };
    }
    return { status: 'ready', record: ready.record };
  }

  /** @inheritdoc */
  resolveTarget(signal?: AbortSignal): Promise<StableResolution> {
    return this.availability.resolveStable({ ...(signal ? { signal } : {}) });
  }

  /** @inheritdoc */
  async update(request: ManagedUpdateRequest): Promise<ManagedUpdateOutcome> {
    const snapshot = await this.state.readReady();
    if (snapshot.status !== 'ready') {
      const refusal = await this.preflightMutation();
      return {
        status: 'failed',
        error:
          refusal.status === 'refused'
            ? refusal.error
            : updateFailure(
                'no-managed-installation',
                'preflight',
                'Run `yantra browser install` to install the managed browser first.',
                'There is no managed installation to replace.',
              ),
        record: snapshot,
      };
    }
    const installed = snapshot.record;

    if (request.consent?.granted !== true) {
      return {
        status: 'failed',
        error: updateFailure(
          'consent-required',
          'preflight',
          'Accept the replacement before updating the managed browser.',
          'No download consent was provided.',
        ),
        record: snapshot,
      };
    }

    // Consent authorizes one operation against one named build. Refusing a
    // mismatch here is what makes "the build you accepted is the build you get"
    // true even when upstream publishes a new Stable mid-operation.
    if (
      request.consent.targetBuildId !== request.target.buildId ||
      request.consent.replaces !== installed.buildId
    ) {
      return {
        status: 'failed',
        error: updateFailure(
          'consent-build-mismatch',
          'preflight',
          'Re-run `yantra browser update` so the build you accept is the build that is installed.',
          `Consent named build ${request.consent.targetBuildId ?? 'none'} replacing ${request.consent.replaces ?? 'none'}, but the operation would install ${request.target.buildId} over ${installed.buildId}.`,
        ),
        record: snapshot,
      };
    }

    const comparison = compareManagedBuild(snapshot, request.target);
    if (comparison.state === 'up-to-date') {
      // No lease, no download, no mutation: there is nothing to replace.
      return { status: 'up-to-date', record: installed, available: request.target };
    }
    if (comparison.state === 'installed-newer') {
      // A silent downgrade is forbidden. Both identities are reported and the
      // installation is left exactly as it is.
      return { status: 'installed-newer', record: installed, available: request.target };
    }

    if (await this.coordinator.hasActiveUse()) {
      return { status: 'failed', error: await this.busyError(), record: snapshot };
    }

    const installationId = this.id();
    const candidate = `${MANAGED_INSTALLATION_PREFIX}${installationId}`;
    let lease: ManagedMutationLease;
    try {
      lease = await this.coordinator.claimMutation(installationId, candidate);
    } catch (cause) {
      return { status: 'failed', error: await this.claimError(cause), record: snapshot };
    }

    this.logger.info(
      {
        consentSource: request.consent.source,
        targetBuildId: request.target.buildId,
        replaces: installed.buildId,
        destinationRoot: this.root(),
      },
      'managed browser replacement starting',
    );

    try {
      const result = await this.acquisition.acquireAndPublish({
        lease,
        targetBuildId: request.target.buildId,
        previousBuildId: installed.buildId,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.onProgress ? { onProgress: request.onProgress } : {}),
        ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
        // The second half of the busy check. A managed launch cannot start once
        // the lease is held, so this closes the only remaining window: a browser
        // that started between the first check and the claim.
        beforePublish: async () => {
          await lease.assertOwned();
          if (await this.coordinator.hasActiveUse()) {
            throw new ManagedInstallException(await this.busyInstallError());
          }
        },
      });

      if (result.status === 'published') {
        this.logger.info(
          {
            previousBuildId: installed.buildId,
            buildId: result.record.buildId,
            orphansDeleted: result.orphans.deleted,
            bytesReclaimed: result.orphans.bytesReclaimed,
            pairing:
              result.compatibility.verdict.status === 'passed'
                ? result.compatibility.verdict.pairing
                : 'failed',
          },
          'managed browser replacement published',
        );
        return {
          status: 'replaced',
          previousBuildId: installed.buildId,
          record: result.record,
          executablePath: result.executablePath,
          compatibility: result.compatibility,
          orphans: result.orphans,
          selection: result.selection,
        };
      }

      if (result.status === 'cancelled') {
        this.logger.info(
          { at: result.at, retainedOrphan: result.retainedOrphan },
          'managed browser replacement cancelled',
        );
        return {
          status: 'cancelled',
          at: result.at,
          retainedOrphan: result.retainedOrphan,
          record: installed,
        };
      }

      this.logger.warn(
        { code: result.error.code, phase: result.error.phase },
        'managed browser replacement failed',
      );
      // Re-read rather than reuse the opening snapshot: the outcome's job is to
      // prove what survived, and a stale copy would only assert it.
      return {
        status: 'failed',
        error: toUpdateError(result.error),
        record: await this.state.readReady(),
      };
    } finally {
      await lease
        .release()
        .catch((cause: unknown) =>
          this.logger.error({ err: describe(cause) }, 'failed to release managed update lease'),
        );
    }
  }

  /** The typed busy refusal, naming the owning PIDs when the coordinator can. */
  private async busyError(): Promise<ManagedUpdateError> {
    const pids = await this.coordinator.activeUseOwners?.().catch(() => []);
    return updateFailure(
      'managed-run-active',
      'preflight',
      'Stop the running Yantra browser sessions, then run `yantra browser update` again.',
      pids === undefined || pids.length === 0
        ? 'A Yantra-managed browser is running, so the installation it is using cannot be replaced.'
        : `A Yantra-managed browser is running (pid ${pids.join(', ')}), so the installation it is using cannot be replaced.`,
      { ...(pids === undefined || pids.length === 0 ? {} : { activeOwnerPids: pids }) },
    );
  }

  /** The same refusal in install-taxonomy shape, for the pre-publication abort. */
  private async busyInstallError(): Promise<ManagedInstallError> {
    const busy = await this.busyError();
    return {
      code: 'operation-in-progress',
      phase: 'publishing',
      remediation: busy.remediation,
      detail: busy.detail,
      retainedOrphan: null,
    };
  }

  /** Distinguishes "a browser is running" from "another operation holds the lease". */
  private async claimError(cause: unknown): Promise<ManagedUpdateError> {
    if (cause instanceof ManagedCoordinationError && cause.context.reason === 'active-use') {
      return this.busyError();
    }
    return updateFailure(
      'operation-in-progress',
      'preflight',
      'Wait for the active managed browser operation to finish, then retry.',
      describe(cause),
    );
  }
}

/**
 * Lifts an install failure into the update taxonomy.
 *
 * It is a widening, not a translation: the codes are the same set, because an
 * extraction failure during a replacement is the same failure with the same
 * repair as one during a first install.
 */
function toUpdateError(error: ManagedInstallError): ManagedUpdateError {
  const { code, phase, remediation, detail, proxyHost, retainedOrphan } = error;
  return {
    code,
    phase,
    remediation,
    detail,
    retainedOrphan,
    ...(proxyHost === undefined ? {} : { proxyHost }),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
