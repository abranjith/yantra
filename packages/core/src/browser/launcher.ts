/**
 * The one place in Yantra that starts a browser process.
 *
 * Task sessions, recorder sessions, and compatibility probes all come through
 * {@link launchResolvedChrome}. Ownership is an explicit discriminated input
 * rather than something each caller arranges for itself, because the failure
 * this consolidation prevents — a browser or a managed reservation surviving a
 * failed startup — is completely silent when each caller rolls its own.
 */

import type { ChildProcess } from 'node:child_process';

import type { Browser, LaunchOptions as PuppeteerLaunchOptions } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

import { toChromeInstall } from './browser-resolver.js';
import { BrowserLaunchError, BrowserProcessError, ManagedCoordinationError } from './errors.js';
import type { ProcessIdentity, ResolvedBrowserInstallation } from './installation-types.js';
import { HARDENED_BASE_ARGS } from './launch-options.js';
import {
  assertCandidateProbePermit,
  revokeCandidateProbePermit,
  trackCandidateProbeProcess,
  type CandidateProbePermit,
  type OwnedManagedUseReservation,
} from './managed-coordination.js';
import { UNKNOWN_START_TOKEN, identifyProcess } from './process-identity.js';
import { BrowserProcessSupervisor, type SupervisorDeps } from './process-lifecycle.js';
import type { ChromeInstall, LaunchOptions, ResolvedProfile } from './types.js';
import { buildUserSimulationArgs, type UserSimulationEnvironment } from './user-simulation.js';

/** @internal Exported for snapshot testing only */
export function buildLaunchArgs(
  opts: LaunchOptions,
  chrome: ChromeInstall,
  environment: UserSimulationEnvironment = {},
): readonly string[] {
  const args: string[] = [...HARDENED_BASE_ARGS, ...buildUserSimulationArgs(chrome, environment)];

  if (opts.viewport) {
    args.push(`--window-size=${opts.viewport.width},${opts.viewport.height}`);
  }

  args.push(...opts.extraArgs);
  return args;
}

/**
 * Who owns the process being started, and therefore what must be released.
 *
 * `candidate-probe` is the narrow seam that lets an install/update operation
 * probe the candidate it is writing: it bypasses only *that operation's own*
 * exclusion, publishes no readiness, and takes no ordinary reservation.
 */
export type LaunchOwnership =
  | { readonly kind: 'external' }
  | { readonly kind: 'managed'; readonly reservation: OwnedManagedUseReservation }
  | { readonly kind: 'candidate-probe'; readonly permit: CandidateProbePermit };

export interface OwnedBrowserProcess {
  readonly browser: Browser;
  readonly child: ChildProcess;
  readonly supervisor: BrowserProcessSupervisor;
  readonly ownership: LaunchOwnership;
  /**
   * Closes the browser, waits for verified process-tree exit, and only then
   * releases ownership. Idempotent.
   *
   * @throws {BrowserProcessError} when exit cannot be proved — the reservation
   * is deliberately kept in that case rather than released on a guess.
   */
  shutdown(): Promise<void>;
}

export interface LaunchDeps extends SupervisorDeps {
  /** External boundary: the actual Puppeteer launch. */
  readonly launch?: (config: PuppeteerLaunchOptions) => Promise<Browser>;
  readonly identify?: (pid: number) => Promise<ProcessIdentity | null>;
  readonly environment?: UserSimulationEnvironment;
  /** Cancels startup. A browser that still arrives afterwards is disposed. */
  readonly signal?: AbortSignal;
}

/**
 * Starts Chrome over CDP pipe transport against an already-resolved installation.
 *
 * @throws {BrowserLaunchError} on spawn, connect, or startup-timeout failure.
 * @throws {BrowserProcessError} when a failed startup could not be cleaned up.
 * @internal Not re-exported through the public core barrel.
 */
export async function launchResolvedChrome(
  opts: LaunchOptions,
  installation: ResolvedBrowserInstallation,
  profile: ResolvedProfile,
  ownership: LaunchOwnership,
  deps: LaunchDeps = {},
): Promise<OwnedBrowserProcess> {
  const launch = deps.launch ?? ((config) => puppeteer.launch(config));
  const identify = deps.identify ?? identifyProcess;
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;

  if (ownership.kind === 'candidate-probe') {
    // Re-proved at the moment of use: a lease can be lost between minting the
    // permit and spawning against it.
    await assertCandidateProbePermit(ownership.permit, {
      candidateRootRelative: ownership.permit.candidateRootRelative,
      executablePath: installation.canonicalPath,
    });
  }

  const args = buildLaunchArgs(opts, toChromeInstall(installation), deps.environment ?? {});
  const config: PuppeteerLaunchOptions = {
    executablePath: installation.canonicalPath,
    args: [...args],
    pipe: true,
    headless: opts.headless,
    userDataDir: profile.absolutePath,
    env: { ...process.env, ...opts.env },
    dumpio: false,
    defaultViewport: opts.viewport,
    // Puppeteer's supported startup timeout, rather than an unowned race that
    // leaves whatever arrives afterwards with no owner.
    timeout: opts.startupTimeoutMs,
    ...(deps.signal ? { signal: deps.signal } : {}),
  };

  let abandoned = false;
  const launching = launch(config);

  // Settlement handler: whatever arrives after we have given up is still ours
  // to close and await. Registered before the first await so no window exists
  // in which a late browser has no owner.
  void launching.then(
    async (late) => {
      if (!abandoned) return;
      await forceDispose(late, deps);
    },
    () => undefined,
  );

  let browser: Browser;
  let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    browser = await Promise.race([
      launching,
      new Promise<never>((_, reject) => {
        boundaryTimer = setTimer(() => {
          reject(
            new BrowserLaunchError({
              phase: 'timeout',
              lastStderr: `Startup did not complete within ${opts.startupTimeoutMs}ms`,
              args: ['<redacted>'],
            }),
          );
        }, opts.startupTimeoutMs);
        (boundaryTimer as { unref?: () => void }).unref?.();
      }),
      abortRejection(deps.signal),
    ]);
  } catch (cause) {
    abandoned = true;
    await releaseUnusedOwnership(ownership);
    throw asLaunchError(cause);
  } finally {
    if (boundaryTimer !== undefined) clearTimer(boundaryTimer);
  }

  const child = browser.process();
  if (child?.pid === undefined) {
    await forceDispose(browser, deps);
    await releaseUnusedOwnership(ownership);
    throw new BrowserLaunchError({
      phase: 'connect',
      lastStderr: 'Could not obtain child process handle from puppeteer',
      args: ['<redacted>'],
    });
  }

  const supervisor = new BrowserProcessSupervisor(child, deps);

  try {
    if (ownership.kind === 'managed') {
      // Persisted as soon as a handle exists — the spawn-to-success window is
      // exactly where an unrecorded browser would otherwise be left behind.
      const identity = (await identify(child.pid)) ?? {
        pid: child.pid,
        startToken: UNKNOWN_START_TOKEN,
      };
      await ownership.reservation.attachChild(identity);
    }
    if (ownership.kind === 'candidate-probe') {
      trackCandidateProbeProcess(ownership.permit, supervisor.whenExited());
    }
  } catch (cause) {
    await shutdownAndRelease(browser, supervisor, ownership);
    throw cause;
  }

  let done: Promise<void> | null = null;
  return {
    browser,
    child,
    supervisor,
    ownership,
    shutdown: () => {
      done ??= shutdownAndRelease(browser, supervisor, ownership);
      return done;
    },
  };
}

/**
 * Closes the browser, proves the tree exited, and only then releases ownership.
 *
 * Ordering matters both ways: releasing before exit would let an update delete
 * a tree a live Chrome still holds open, and refusing to release after a proven
 * exit would wedge the installation.
 */
async function shutdownAndRelease(
  browser: Browser,
  supervisor: BrowserProcessSupervisor,
  ownership: LaunchOwnership,
): Promise<void> {
  await supervisor.shutdown(() => browser.close());
  if (ownership.kind === 'managed') {
    try {
      await ownership.reservation.releaseAfterExit();
    } catch (cause) {
      // The reservation is kept on purpose; the caller gets typed evidence
      // rather than a success that would authorize deleting a live tree.
      throw new BrowserProcessError({
        phase: 'cleanup',
        detail:
          cause instanceof ManagedCoordinationError
            ? cause.message
            : `the managed reservation could not be released: ${describe(cause)}`,
        exitProven: supervisor.hasExited(),
      });
    }
  }
  if (ownership.kind === 'candidate-probe') {
    revokeCandidateProbePermit(ownership.permit);
  }
}

/** Releases a reservation that never got a browser, with the never-spawned proof. */
async function releaseUnusedOwnership(ownership: LaunchOwnership): Promise<void> {
  if (ownership.kind === 'managed') {
    await ownership.reservation.markNeverSpawned().catch(() => undefined);
  }
  if (ownership.kind === 'candidate-probe') {
    revokeCandidateProbePermit(ownership.permit);
  }
}

/** Closes a browser we are abandoning and waits for its process to exit. */
async function forceDispose(browser: Browser, deps: LaunchDeps): Promise<void> {
  const child = browser.process();
  if (!child) {
    await browser.close().catch(() => undefined);
    return;
  }
  const supervisor = new BrowserProcessSupervisor(child, deps);
  await supervisor.shutdown(() => browser.close()).catch(() => undefined);
}

/**
 * Rejects when startup is cancelled.
 *
 * Puppeteer closes the browser on an aborted signal but does not wait for the
 * process to go away, so cancellation still has to come back through this
 * module's settlement handler to be accounted for.
 */
function abortRejection(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) return new Promise<never>(() => undefined);
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    signal.addEventListener('abort', () => reject(cancelled()), { once: true });
  });
}

function cancelled(): BrowserLaunchError {
  return new BrowserLaunchError({
    phase: 'timeout',
    lastStderr: 'Browser startup was cancelled',
    args: ['<redacted>'],
  });
}

function asLaunchError(cause: unknown): Error {
  if (cause instanceof BrowserLaunchError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new BrowserLaunchError({
    phase: /timed out|timeout/i.test(message) ? 'timeout' : 'connect',
    lastStderr: message,
    args: ['<redacted>'],
  });
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
