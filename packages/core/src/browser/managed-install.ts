import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';

import { Browser, computeExecutablePath } from '@puppeteer/browsers';

import { LocalBrowserCompatibilityService } from './compatibility.js';
import {
  MANAGED_INSTALLATION_PREFIX,
  type BrowserCompatibilityService,
  type BrowserSelectionReader,
  type CompatibilityResult,
  type ManagedCoordinator,
  type ManagedReadyRecord,
  type ManagedStateReader,
} from './installation-types.js';
import {
  issueCandidateProbePermit,
  revokeCandidateProbePermit,
  type CandidateProbePermit,
} from './managed-coordination.js';
import {
  ManagedInstallHelperClient,
  type ManagedHelperRunOutcome,
} from './managed-install-helper-client.js';
import {
  DEFAULT_MANAGED_INSTALL_POLICY,
  type HelperRequest,
  type ManagedAcquisitionOptions,
  type ManagedAcquisitionResult,
  type ManagedAcquisitionService,
  type ManagedInstallOutcome,
  type ManagedInstallPhase,
  type ManagedInstallPolicy,
  type ManagedInstallRequest,
  type ManagedInstallService,
  type OrphanCollectionReport,
} from './managed-install-types.js';
import {
  installFailure,
  ManagedInstallException,
  managedPreflight,
  type ManagedPreflightResult,
} from './managed-preflight.js';
import { managedExecutablePath } from './managed-state.js';
import { OrphanCollector } from './orphan-collection.js';
import { managedBrowsersRoot, managedInstallationRoot, managedReadyPath } from './paths.js';
import type { Logger } from './types.js';

interface CandidateProbeService {
  probeManagedCandidate(
    permit: CandidateProbePermit,
    profile: 'automation',
    signal?: AbortSignal,
  ): Promise<CompatibilityResult>;
}

interface HelperRunner {
  run(
    request: HelperRequest,
    policy: ManagedInstallPolicy,
    options?: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (
        phase: ManagedInstallOutcomePhase,
        buildId: string | null,
        downloaded: number,
        total: number | null,
        interruptible: boolean,
      ) => void;
    },
  ): Promise<ManagedHelperRunOutcome>;
}

type ManagedInstallOutcomePhase = ManagedInstallPhase;

export interface ManagedInstallDeps {
  readonly state: ManagedStateReader;
  readonly coordinator: ManagedCoordinator;
  readonly compatibility?: BrowserCompatibilityService;
  readonly candidateProbe?: CandidateProbeService;
  readonly helper?: HelperRunner;
  readonly collector?: OrphanCollector;
  readonly selectionReader?: BrowserSelectionReader;
  readonly root?: () => string;
  readonly candidateRoot?: (installationId: string) => string;
  readonly readyPath?: () => string;
  readonly preflight?: (policy: ManagedInstallPolicy) => Promise<ManagedPreflightResult>;
  readonly policy?: ManagedInstallPolicy;
  readonly id?: () => string;
  readonly clock?: () => Date;
  readonly logger?: Logger;
  readonly writeReadyTemp?: typeof writeFile;
  readonly renameReady?: typeof rename;
  readonly removeReadyTemp?: typeof rm;
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};
const emptyReport = (): OrphanCollectionReport => ({
  attempted: 0,
  deleted: 0,
  bytesReclaimed: 0,
  skippedLiveOwner: 0,
  failed: [],
});

/** Coordinates one consented candidate from local preflight through atomic publication. */
export class LocalManagedInstallService
  implements ManagedInstallService, ManagedAcquisitionService
{
  private readonly state: ManagedStateReader;
  private readonly coordinator: ManagedCoordinator;
  private readonly compatibility: BrowserCompatibilityService;
  private readonly candidateProbe: CandidateProbeService;
  private readonly helper: HelperRunner;
  private readonly collector: OrphanCollector;
  private readonly selectionReader: BrowserSelectionReader | undefined;
  private readonly root: () => string;
  private readonly candidateRoot: (installationId: string) => string;
  private readonly readyPath: () => string;
  private readonly preflight: (policy: ManagedInstallPolicy) => Promise<ManagedPreflightResult>;
  private readonly policy: ManagedInstallPolicy;
  private readonly id: () => string;
  private readonly clock: () => Date;
  private readonly logger: Logger;
  private readonly writeReadyTemp: typeof writeFile;
  private readonly renameReady: typeof rename;
  private readonly removeReadyTemp: typeof rm;

  constructor(deps: ManagedInstallDeps) {
    const localCompatibility = new LocalBrowserCompatibilityService({
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.root ? { managedRoot: deps.root } : {}),
    });
    this.state = deps.state;
    this.coordinator = deps.coordinator;
    this.compatibility = deps.compatibility ?? localCompatibility;
    this.candidateProbe = deps.candidateProbe ?? localCompatibility;
    this.helper = deps.helper ?? new ManagedInstallHelperClient();
    this.root = deps.root ?? managedBrowsersRoot;
    this.candidateRoot = deps.candidateRoot ?? managedInstallationRoot;
    this.readyPath = deps.readyPath ?? managedReadyPath;
    this.collector = deps.collector ?? new OrphanCollector({ state: deps.state, root: this.root });
    this.selectionReader = deps.selectionReader;
    this.policy = deps.policy ?? DEFAULT_MANAGED_INSTALL_POLICY;
    this.preflight = deps.preflight ?? ((policy) => managedPreflight({ root: this.root }, policy));
    this.id = deps.id ?? randomUUID;
    this.clock = deps.clock ?? (() => new Date());
    this.logger = deps.logger ?? noopLogger;
    this.writeReadyTemp = deps.writeReadyTemp ?? writeFile;
    this.renameReady = deps.renameReady ?? rename;
    this.removeReadyTemp = deps.removeReadyTemp ?? rm;
  }

  collectOrphans(): Promise<OrphanCollectionReport> {
    return this.collector.collect();
  }

  async install(request: ManagedInstallRequest): Promise<ManagedInstallOutcome> {
    if (request.consent?.granted !== true) {
      return {
        status: 'failed',
        error: installFailure(
          'consent-required',
          'preflight',
          'Accept the download before installing a managed browser.',
          'No download consent was provided.',
        ),
      };
    }
    this.logger.info(
      {
        trigger: request.trigger,
        consentSource: request.consent.source,
        destinationRoot: this.root(),
      },
      'managed browser installation starting',
    );
    const existing = await this.state.readReady();
    if (existing.status === 'ready') return this.alreadyInstalled(existing.record);

    const installationId = this.id();
    const candidate = `installation-${installationId}`;
    let lease;
    try {
      lease = await this.coordinator.claimMutation(installationId, candidate);
    } catch (cause) {
      return {
        status: 'failed',
        error: installFailure(
          'operation-in-progress',
          'preflight',
          'Wait for the active managed browser operation or run to finish.',
          describe(cause),
        ),
      };
    }

    try {
      // A first install resolves Stable inside the helper: there is nothing
      // installed for a user to have consented to replacing.
      const result = await this.acquireAndPublish({
        lease,
        targetBuildId: request.consent.targetBuildId ?? null,
        previousBuildId: null,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.onProgress ? { onProgress: request.onProgress } : {}),
        ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
      });
      if (result.status === 'published') {
        return {
          status: 'installed',
          record: result.record,
          executablePath: result.executablePath,
          compatibility: result.compatibility,
          orphans: result.orphans,
          selection: result.selection,
        };
      }
      if (result.status === 'cancelled') {
        return { status: 'cancelled', at: result.at, retainedOrphan: result.retainedOrphan };
      }
      return { status: 'failed', error: result.error };
    } finally {
      await lease
        .release()
        .catch((cause: unknown) =>
          this.logger.error(
            { err: describe(cause) },
            'failed to release managed installation lease',
          ),
        );
    }
  }

  /**
   * @inheritdoc
   *
   * The one place a managed browser is acquired and published. The caller owns
   * the lease (claim and release), because install and update map a refused
   * claim onto different user-facing codes; everything from that point on is
   * identical and lives here.
   */
  async acquireAndPublish(options: ManagedAcquisitionOptions): Promise<ManagedAcquisitionResult> {
    const { lease } = options;
    const candidate = lease.candidateRootRelative;
    const installationId = candidate.slice(MANAGED_INSTALLATION_PREFIX.length);
    const request = options;

    let candidateCreated = false;
    let lastLoggedPhase: ManagedInstallPhase | null = null;
    const emitProgress = (
      event: Parameters<NonNullable<ManagedInstallRequest['onProgress']>>[0],
    ) => {
      if (event.phase !== lastLoggedPhase) {
        lastLoggedPhase = event.phase;
        this.logger.info(
          {
            phase: event.phase,
            buildId: event.buildId,
            interruptible: event.interruptible,
            resumable: event.resumable,
          },
          'managed browser installation phase',
        );
      }
      request.onProgress?.(event);
    };
    try {
      emitProgress({
        phase: 'collecting-orphans',
        buildId: null,
        resumable: false,
        interruptible: true,
      });
      const collectedBefore = await this.collectOrphans();
      this.logger.info(
        {
          attempted: collectedBefore.attempted,
          deleted: collectedBefore.deleted,
          bytesReclaimed: collectedBefore.bytesReclaimed,
          skippedLiveOwner: collectedBefore.skippedLiveOwner,
          failed: collectedBefore.failed.length,
        },
        'managed browser orphan collection completed',
      );
      const effectivePolicy = {
        ...this.policy,
        ...(request.deadlineMs === undefined ? {} : { wholeOperationMs: request.deadlineMs }),
      };
      emitProgress({
        phase: 'preflight',
        buildId: null,
        resumable: false,
        interruptible: true,
      });
      const preflight = await this.preflight(effectivePolicy);
      const candidatePath = this.candidateRoot(installationId);
      await mkdir(candidatePath, { recursive: true, mode: 0o700 });
      candidateCreated = true;
      const helper = await this.helper.run(
        {
          protocolVersion: 2,
          mode: 'install',
          operationId: installationId,
          browser: 'chrome',
          platform: preflight.platform,
          cacheDir: candidatePath,
          // The exact accepted build for an update; `null` lets a first install
          // resolve Stable in-helper. Either way it is never re-resolved later.
          buildId: request.targetBuildId,
          progressIntervalMs: this.policy.progressIntervalMs,
        },
        effectivePolicy,
        {
          ...(request.signal ? { signal: request.signal } : {}),
          onProgress: (phase, buildId, downloaded, total, interruptible) =>
            emitProgress({
              phase,
              buildId,
              downloadedBytes: downloaded,
              totalBytes: total,
              ...(total !== null && total > 0
                ? { percent: Math.min(100, Math.floor((downloaded / total) * 100)) }
                : {}),
              resumable: false,
              interruptible,
            }),
        },
      );
      if (helper.status === 'cancelled') {
        this.logger.info(
          { phase: helper.at, retainedOrphan: candidateCreated ? candidate : null },
          'managed browser installation cancelled',
        );
        return {
          status: 'cancelled',
          at: helper.at,
          retainedOrphan: candidateCreated ? candidate : null,
        };
      }

      emitProgress({
        phase: 'verifying',
        buildId: helper.buildId,
        resumable: false,
        interruptible: true,
      });
      const executablePath = computeExecutablePath({
        browser: Browser.CHROME,
        buildId: helper.buildId,
        platform: preflight.platform as never,
        cacheDir: candidatePath,
      });
      await access(executablePath, constants.X_OK);
      const record: ManagedReadyRecord = {
        schemaVersion: 1,
        installationId,
        browser: 'chrome',
        platform: preflight.platform,
        buildId: helper.buildId,
        cacheRootRelative: candidate,
        executableRelative: relative(candidatePath, executablePath),
        verifiedAt: this.clock().toISOString(),
      };
      const permit = issueCandidateProbePermit(lease, {
        candidateRootRelative: candidate,
        executablePath,
      });
      let compatibility: CompatibilityResult;
      try {
        compatibility = await this.candidateProbe.probeManagedCandidate(
          permit,
          'automation',
          request.signal,
        );
      } finally {
        revokeCandidateProbePermit(permit);
      }
      if (compatibility.verdict.status === 'failed') {
        throw new ManagedInstallException(
          installFailure(
            'compatibility-failure',
            'verifying',
            compatibility.verdict.remediation,
            'The managed browser did not pass required capabilities.',
            { probeFailure: compatibility.verdict.failureClass },
          ),
        );
      }

      // The last point at which aborting is free: the pointer is untouched and
      // the candidate is an ordinary orphan. Update re-verifies here that no
      // browser started during the transfer.
      await request.beforePublish?.();

      emitProgress({
        phase: 'publishing',
        buildId: helper.buildId,
        resumable: false,
        interruptible: true,
      });
      await this.publish(record);
      const postPublish = await this.collectOrphans().catch((cause: unknown) => {
        this.logger.warn(
          { err: describe(cause) },
          'published managed browser; previous orphan collection will retry later',
        );
        return collectedBefore;
      });
      const configured = await this.selectionReader?.read().catch(() => undefined);
      const configuredSource = configured?.source ?? 'auto';
      this.logger.info(
        {
          buildId: record.buildId,
          compatibility: compatibility.verdict,
          orphansDeleted: postPublish.deleted,
          bytesReclaimed: postPublish.bytesReclaimed,
        },
        'managed browser installation published',
      );
      return {
        status: 'published',
        record,
        executablePath,
        compatibility,
        orphans: postPublish,
        previousBuildId: request.previousBuildId,
        selection: {
          configuredSource,
          selectsThisInstallation: configuredSource !== 'system',
          command: configuredSource === 'system' ? 'yantra browser use managed' : null,
        },
      };
    } catch (cause) {
      const error =
        cause instanceof ManagedInstallException
          ? cause.context
          : installFailure(
              'verification-failure',
              'verifying',
              'Re-run the explicit browser install.',
              describe(cause),
            );
      this.logger.warn(
        {
          code: error.code,
          phase: error.phase,
          retainedOrphan: candidateCreated ? candidate : null,
        },
        'managed browser installation failed',
      );
      return {
        status: 'failed',
        error: { ...error, retainedOrphan: candidateCreated ? candidate : null },
      };
    }
  }

  private async alreadyInstalled(record: ManagedReadyRecord): Promise<ManagedInstallOutcome> {
    const executablePath = managedExecutablePath(record, this.root()).path;
    let compatibility: Awaited<ReturnType<BrowserCompatibilityService['readCached']>> = {
      state: 'unverified',
    };
    try {
      const identified = await import('./browser-resolver.js').then(({ identifyExecutable }) =>
        identifyExecutable(executablePath),
      );
      if (identified !== null) {
        compatibility = await this.compatibility.readCached(
          {
            ...identified,
            ownership: 'managed',
            requestedSelection: { source: 'managed', executablePath: null },
            selectionOrigin: 'invocation',
            selectionReason: 'managed-explicit',
            channel: 'stable',
            managedIdentity: record,
          },
          'automation',
        );
      }
    } catch {
      // A local evidence read is opportunistic; install remains network-free.
    }
    const orphans = await this.collectOrphans().catch(emptyReport);
    this.logger.info(
      {
        buildId: record.buildId,
        compatibility: compatibility.state,
        orphansDeleted: orphans.deleted,
        bytesReclaimed: orphans.bytesReclaimed,
      },
      'managed browser installation already present',
    );
    return {
      status: 'already-installed',
      record,
      executablePath,
      compatibility,
      orphans,
      updateCommand: 'yantra browser update',
    };
  }

  private async publish(record: ManagedReadyRecord): Promise<void> {
    await mkdir(this.root(), { recursive: true, mode: 0o700 });
    const temp = `${this.readyPath()}.${record.installationId}.tmp`;
    try {
      await this.writeReadyTemp(temp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
      await this.renameReady(temp, this.readyPath());
    } catch (cause) {
      await this.removeReadyTemp(temp, { force: true }).catch(() => undefined);
      throw new ManagedInstallException(
        installFailure(
          'publication-failure',
          'publishing',
          'Check the managed browser directory permissions and retry.',
          describe(cause),
        ),
      );
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
