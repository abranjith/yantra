/**
 * Stable resolution and the installed-versus-available comparison.
 *
 * Everything here is metadata and arithmetic. Nothing in this module takes a
 * lease, creates a directory, writes a file, downloads a byte, or records that
 * a check happened — a `--dry-run` run is required to leave the data root, the
 * cache root, and `config.yaml` byte-identical, and this is the module that
 * claim rests on.
 */

import { Browser, getVersionComparator } from '@puppeteer/browsers';

import { cftPlatformFor } from './driver-compatibility.js';
import type { ManagedPlatform, ManagedReadySnapshot } from './installation-types.js';
import type { ManagedHelperRunOutcome } from './managed-install-helper-client.js';
import { ManagedInstallHelperClient } from './managed-install-helper-client.js';
import {
  DEFAULT_MANAGED_INSTALL_POLICY,
  type HelperRequest,
  type ManagedInstallPolicy,
} from './managed-install-types.js';
import { ManagedInstallException } from './managed-preflight.js';
import {
  updateFailure,
  type StableBuild,
  type StableResolution,
  type StableResolutionService,
  type UpdateComparison,
} from './managed-update-types.js';
import type { Logger } from './types.js';

/** The subset of the helper client this module drives. Injected so tests own the process. */
interface HelperRunner {
  run(
    request: HelperRequest,
    policy: ManagedInstallPolicy,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ManagedHelperRunOutcome>;
}

export interface StableResolutionDeps {
  readonly helper?: HelperRunner;
  readonly policy?: ManagedInstallPolicy;
  /** Host → Chrome-for-Testing platform. Defaults to the driver descriptor's mapping. */
  readonly platform?: () => ManagedPlatform | null;
  readonly clock?: () => Date;
  readonly id?: () => string;
  readonly logger?: Logger;
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * Resolves current Chrome for Testing Stable through the owned helper.
 *
 * The helper is used rather than an in-process call for one reason that matters
 * more than isolation: it is spawned with `NODE_USE_ENV_PROXY=1` and a fixed
 * environment allowlist, so a configured proxy is actually honored. The
 * browsers package imports `proxy-agent` optionally and silently goes direct
 * when it is absent, and a silently bypassed proxy is exactly the failure a
 * user cannot see.
 */
export class LocalStableResolutionService implements StableResolutionService {
  private readonly helper: HelperRunner;
  private readonly policy: ManagedInstallPolicy;
  private readonly platform: () => ManagedPlatform | null;
  private readonly clock: () => Date;
  private readonly id: () => string;
  private readonly logger: Logger;

  constructor(deps: StableResolutionDeps = {}) {
    this.helper = deps.helper ?? new ManagedInstallHelperClient();
    this.policy = deps.policy ?? DEFAULT_MANAGED_INSTALL_POLICY;
    this.platform = deps.platform ?? (() => cftPlatformFor(process.platform, process.arch));
    this.clock = deps.clock ?? (() => new Date());
    this.id = deps.id ?? (() => `availability-${Date.now().toString(36)}`);
    this.logger = deps.logger ?? noopLogger;
  }

  /** @inheritdoc */
  async resolveStable(
    options: { readonly signal?: AbortSignal; readonly deadlineMs?: number } = {},
  ): Promise<StableResolution> {
    const platform = this.platform();
    if (platform === null) {
      return {
        status: 'unavailable',
        error: updateFailure(
          'unsupported-platform',
          'resolving-stable',
          'Chrome for Testing is not published for this host. Use a compatible external Chrome or Chromium instead.',
          'This host has no Chrome for Testing artifact.',
        ),
      };
    }

    // Resolve mode answers one question, so the whole-operation deadline is the
    // metadata deadline: there is no download phase for a longer budget to cover.
    const deadline = options.deadlineMs ?? this.policy.metadataMs;
    const policy: ManagedInstallPolicy = {
      ...this.policy,
      metadataMs: deadline,
      wholeOperationMs: deadline,
    };

    let outcome: ManagedHelperRunOutcome;
    try {
      outcome = await this.helper.run(
        {
          protocolVersion: 2,
          mode: 'resolve',
          operationId: this.id(),
          browser: 'chrome',
          platform,
          // Resolve mode writes nothing, so it is given nowhere to write.
          cacheDir: null,
          buildId: null,
          progressIntervalMs: this.policy.progressIntervalMs,
        },
        policy,
        { ...(options.signal ? { signal: options.signal } : {}) },
      );
    } catch (cause) {
      return { status: 'unavailable', error: toResolutionError(cause) };
    }

    if (outcome.status !== 'availability') {
      // A cancelled or install-shaped answer to a resolve request is a protocol
      // failure, not an availability answer, and must never be rendered as one.
      return {
        status: 'unavailable',
        error: updateFailure(
          outcome.status === 'cancelled' ? 'timed-out' : 'helper-crashed',
          'resolving-stable',
          'Retry `yantra browser update --dry-run`.',
          outcome.status === 'cancelled'
            ? 'Stable metadata resolution was cancelled before it answered.'
            : 'The metadata helper answered an install result to a resolve request.',
        ),
      };
    }

    const build: StableBuild = {
      buildId: outcome.buildId,
      platform,
      resolvedAt: this.clock().toISOString(),
      artifactAvailable: outcome.artifactAvailable,
    };
    this.logger.info(
      { buildId: build.buildId, platform, artifactAvailable: build.artifactAvailable },
      'resolved current Chrome for Testing Stable',
    );
    return { status: 'resolved', build };
  }
}

/**
 * Compares the recorded managed build against an available Stable build.
 *
 * Ordering comes from `getVersionComparator(Browser.CHROME)` in the pinned
 * package, never a hand-rolled dotted compare: a version grammar duplicated
 * beside the one that owns it is silent divergence, and this one disagrees with
 * lexicographic order on exactly the builds that occur (`…8010.9` precedes
 * `…8010.36`).
 */
export function compareManagedBuild(
  installed: ManagedReadySnapshot,
  available: StableBuild,
): UpdateComparison {
  if (installed.status !== 'ready') {
    return {
      state: 'no-installation',
      available,
      installCommand: 'yantra browser install',
    };
  }
  const order = getVersionComparator(Browser.CHROME)(installed.record.buildId, available.buildId);
  if (order === 0) return { state: 'up-to-date', installed: installed.record, available };
  if (order < 0) return { state: 'update-available', installed: installed.record, available };
  // Never a downgrade proposal: both identities are reported and the
  // installation is left exactly as it is.
  return { state: 'installed-newer', installed: installed.record, available };
}

/** The exact command the comparison points at, or `null` when nothing is to be done. */
export function nextCommandFor(comparison: UpdateComparison): string | null {
  if (comparison.state === 'no-installation') return 'yantra browser install';
  if (comparison.state === 'update-available') return 'yantra browser update';
  return null;
}

/** Maps a helper-client exception onto the shared taxonomy with credentials stripped. */
function toResolutionError(cause: unknown): ReturnType<typeof updateFailure> {
  if (cause instanceof ManagedInstallException) {
    const { code, phase, remediation, detail, proxyHost } = cause.context;
    return updateFailure(code, phase, remediation, detail, {
      ...(proxyHost === undefined ? {} : { proxyHost }),
    });
  }
  return updateFailure(
    'metadata-unavailable',
    'resolving-stable',
    'Check network access to Chrome for Testing metadata and retry.',
    cause instanceof Error ? cause.message : String(cause),
  );
}
