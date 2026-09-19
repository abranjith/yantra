/**
 * The single local compatibility probe.
 *
 * One implementation, one session contract: the probe *always* launches its own
 * isolated headless synthetic session with its own ephemeral profile — never
 * the session the user is about to work in — and *always* closes that session
 * and that profile, on success and on failure alike.
 *
 * A second probe implementation inside the launcher or the managed path is
 * forbidden. Memory records what divergent duplicate contracts already cost in
 * the actionability layer, where two independent "is this ready" implementations
 * silently disagreed for the whole life of one of them.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';

import type { Browser, CDPSession, Page as PuppeteerPage } from 'puppeteer-core';

import { PuppeteerInjectedScriptHost } from '../locator/injected-host.js';

import { identifyExecutable } from './browser-resolver.js';
import { CompatibilityCache } from './compatibility-cache.js';
import {
  DRIVER_COMPATIBILITY,
  capabilityTableHash,
  pairingFor,
  requiredCapabilities,
} from './driver-compatibility.js';
import { ManagedCoordinationError } from './errors.js';
import type {
  BrowserCompatibilityService,
  CapabilityEvidence,
  CapabilityId,
  CompatibilityCheckOptions,
  CompatibilityDecision,
  CompatibilityEvidenceState,
  CompatibilityResult,
  DriverCompatibilityDescriptor,
  ProbeFailureClass,
  ProbeProfile,
  ResolvedBrowserInstallation,
} from './installation-types.js';
import { parseLaunchOptions } from './launch-options.js';
import { launchResolvedChrome, type LaunchOwnership } from './launcher.js';
import { assertCandidateProbePermit, type CandidateProbePermit } from './managed-coordination.js';
import { canonicalize } from './managed-state.js';
import { managedBrowsersRoot } from './paths.js';
import { LocalProfileStore } from './profile-store.js';
import type { Logger, ProfileStore } from './types.js';

/** Startup allowance for a synthetic probe session. */
const PROBE_STARTUP_TIMEOUT_MS = 30_000;

/** How long any single capability may take before it counts as failed. */
const CAPABILITY_TIMEOUT_MS = 15_000;

/* eslint-disable @typescript-eslint/no-empty-function */
const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
/* eslint-enable @typescript-eslint/no-empty-function */

/**
 * The synthetic environment a capability row is exercised against.
 *
 * There is no task URL, no user profile, and no provider session in here by
 * construction — the probe cannot reach any of them.
 */
export interface ProbeContext {
  readonly browser: Browser;
  /** The one synthetic page, created on demand and owned by the probe. */
  page(): Promise<PuppeteerPage>;
  /** A CDP session on the synthetic page, created on demand. */
  cdp(): Promise<CDPSession>;
  readonly signal?: AbortSignal | undefined;
}

/** A capability check. Resolves when the primitive works, throws when it does not. */
export type CapabilityRunner = (ctx: ProbeContext) => Promise<void>;

// ---------------------------------------------------------------------------
// Capability runners
// ---------------------------------------------------------------------------

const SELECT_ALL_CLICK_COUNT = 3;

async function probePipeVersion(ctx: ProbeContext): Promise<void> {
  const version = await ctx.browser.version();
  if (typeof version !== 'string' || !/chrom/i.test(version)) {
    throw new Error(`the CDP pipe returned an unusable browser version: "${String(version)}"`);
  }
}

async function probeRuntimeEvaluate(ctx: ProbeContext): Promise<void> {
  const page = await ctx.page();
  const answer = await page.evaluate(() => 6 * 7);
  if (answer !== 42) throw new Error(`page evaluation returned ${String(answer)}, expected 42`);
}

async function probeDomHandles(ctx: ProbeContext): Promise<void> {
  const page = await ctx.page();
  await page.setContent('<div id="probe-target">handle</div>');
  const handle = await page.$('#probe-target');
  if (handle === null) throw new Error('an element present in the document could not be collected');
  try {
    const text = await handle.evaluate((el) => el.textContent);
    if (text !== 'handle') throw new Error(`element handle read "${String(text)}"`);
  } finally {
    await handle.dispose();
  }
}

/**
 * The gesture the fill path actually uses: triple-click to select, then type.
 *
 * Appending instead of replacing is silent — no exception, no log line, no type
 * error — so it is proved here on a pre-populated field rather than assumed.
 */
async function probeClickReplace(ctx: ProbeContext): Promise<void> {
  const page = await ctx.page();
  await page.setContent('<input id="probe-field" value="seed value">');
  const handle = await page.$('#probe-field');
  if (handle === null) throw new Error('the synthetic input could not be collected');
  try {
    const box = await handle.boundingBox();
    if (box === null) throw new Error('the synthetic input reported no layout box');
    await handle.focus();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
      count: SELECT_ALL_CLICK_COUNT,
    });
    await handle.type('replaced');
    const value = await handle.evaluate((el) => (el as HTMLInputElement).value);
    if (value !== 'replaced') {
      throw new Error(`filling a pre-populated field produced "${String(value)}", not "replaced"`);
    }
  } finally {
    await handle.dispose();
  }
}

async function probeFrameToken(ctx: ProbeContext): Promise<void> {
  const page = await ctx.page();
  await page.setContent('<iframe id="probe-frame" srcdoc="<p>child</p>"></iframe>');
  await page.waitForFunction(() => document.querySelectorAll('iframe').length === 1, {
    timeout: 5_000,
  });
  const child = page.frames().find((frame) => frame !== page.mainFrame());
  if (child === undefined) throw new Error('a synthetic same-origin frame never attached');

  const host = new PuppeteerInjectedScriptHost(page);
  const token = host.getFrameId(child);
  if (token === 'main' || token.length === 0) {
    throw new Error(`a non-main frame produced the token "${token}"`);
  }

  await page.evaluate(() => document.querySelector('#probe-frame')?.remove());
  await page.waitForFunction(() => document.querySelectorAll('iframe').length === 0, {
    timeout: 5_000,
  });
  let rejectedAfterDetach = false;
  try {
    host.getFrameId(child);
  } catch {
    rejectedAfterDetach = true;
  }
  if (!rejectedAfterDetach) {
    throw new Error('a frame token still resolved after its frame detached');
  }
}

async function probePopupSession(ctx: ProbeContext): Promise<void> {
  const page = await ctx.page();
  await page.setContent('<button id="probe-popup">open</button>');
  const popupArrival = new Promise<PuppeteerPage | null>((resolve) => {
    page.once('popup', (popup) => resolve(popup ?? null));
  });
  await page.evaluate(() => window.open('about:blank', '_blank'));
  const popup = await withTimeout(popupArrival, 5_000, 'no popup page was reported');
  if (popup === null) throw new Error('the popup event carried no page');

  const popupSession = await popup.createCDPSession();
  try {
    const info = (await popupSession.send('Target.getTargetInfo')) as {
      targetInfo: { targetId: string };
    };
    const mainSession = await ctx.cdp();
    const mainInfo = (await mainSession.send('Target.getTargetInfo')) as {
      targetInfo: { targetId: string };
    };
    if (info.targetInfo.targetId === mainInfo.targetInfo.targetId) {
      throw new Error('the popup shares the opener’s CDP target instead of owning its own');
    }
  } finally {
    await popupSession.detach().catch(() => undefined);
    await popup.close().catch(() => undefined);
  }
}

async function probeRecorderBinding(ctx: ProbeContext): Promise<void> {
  const page = await ctx.page();
  const cdp = await ctx.cdp();
  await cdp.send('Runtime.enable');
  await cdp.send('Runtime.addBinding', { name: '__yantraProbeBinding' });

  const called = new Promise<string>((resolve) => {
    cdp.on('Runtime.bindingCalled', (params: unknown) => {
      const typed = params as { name?: string; payload?: string };
      if (typed.name === '__yantraProbeBinding') resolve(typed.payload ?? '');
    });
  });
  await page.evaluate(() => {
    (window as unknown as Record<string, (p: string) => void>).__yantraProbeBinding?.('ping');
  });
  const payload = await withTimeout(called, 5_000, 'the CDP binding was never invoked');
  if (payload !== 'ping') throw new Error(`the binding delivered "${payload}", expected "ping"`);
}

async function probeRecorderPreload(ctx: ProbeContext): Promise<void> {
  const page = await ctx.page();
  const cdp = await ctx.cdp();
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__yantraProbePreload = true;',
  });
  // A real navigation, not `setContent`: replacing a document's markup reuses
  // the same document, so it never exercises the new-document hook the recorder
  // overlay depends on. `about:blank` keeps this in-memory and offline.
  await page.goto('about:blank');
  const present = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__yantraProbePreload === true,
  );
  if (!present) throw new Error('a preload script did not run before the new document');
}

async function probeRecorderPageDomain(ctx: ProbeContext): Promise<void> {
  const cdp = await ctx.cdp();
  await cdp.send('Page.enable');
  const tree = (await cdp.send('Page.getFrameTree')) as {
    frameTree?: { frame?: { id?: string } };
  };
  const id = tree.frameTree?.frame?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('the Page domain reported no frame tree');
  }
}

const DEFAULT_RUNNERS: Readonly<Record<CapabilityId, CapabilityRunner>> = Object.freeze({
  'pipe-version': probePipeVersion,
  'runtime-evaluate': probeRuntimeEvaluate,
  'dom-handles': probeDomHandles,
  'click-replace': probeClickReplace,
  'frame-token': probeFrameToken,
  'popup-session': probePopupSession,
  'recorder-binding': probeRecorderBinding,
  'recorder-preload': probeRecorderPreload,
  'recorder-page-domain': probeRecorderPageDomain,
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface CompatibilityServiceDeps {
  readonly descriptor?: DriverCompatibilityDescriptor;
  readonly cache?: CompatibilityCache;
  readonly profileStore?: ProfileStore;
  /** External boundary: the shared launch path. */
  readonly launch?: typeof launchResolvedChrome;
  readonly capabilityRunners?: Partial<Record<CapabilityId, CapabilityRunner>>;
  readonly clock?: () => Date;
  readonly logger?: Logger;
  readonly managedRoot?: () => string;
  /** Reads the installation's own `deb.deps`, for package-level remediation. */
  readonly readDebDeps?: (executablePath: string) => Promise<string | null>;
  readonly identify?: typeof identifyExecutable;
  readonly startupTimeoutMs?: number;
}

/** The one {@link BrowserCompatibilityService} implementation. */
export class LocalBrowserCompatibilityService implements BrowserCompatibilityService {
  private readonly descriptor: DriverCompatibilityDescriptor;
  private readonly cache: CompatibilityCache;
  private readonly profileStore: ProfileStore;
  private readonly launch: typeof launchResolvedChrome;
  private readonly runners: Readonly<Record<CapabilityId, CapabilityRunner>>;
  private readonly clock: () => Date;
  private readonly logger: Logger;
  private readonly managedRoot: () => string;
  private readonly readDebDeps: (executablePath: string) => Promise<string | null>;
  private readonly identify: typeof identifyExecutable;
  private readonly startupTimeoutMs: number;

  constructor(deps: CompatibilityServiceDeps = {}) {
    this.descriptor = deps.descriptor ?? DRIVER_COMPATIBILITY;
    this.cache = deps.cache ?? new CompatibilityCache({ descriptor: this.descriptor });
    this.profileStore = deps.profileStore ?? new LocalProfileStore();
    this.launch = deps.launch ?? launchResolvedChrome;
    this.runners = { ...DEFAULT_RUNNERS, ...deps.capabilityRunners };
    this.clock = deps.clock ?? (() => new Date());
    this.logger = deps.logger ?? noopLogger;
    this.managedRoot = deps.managedRoot ?? managedBrowsersRoot;
    this.readDebDeps = deps.readDebDeps ?? readDebDepsFile;
    this.identify = deps.identify ?? identifyExecutable;
    this.startupTimeoutMs = deps.startupTimeoutMs ?? PROBE_STARTUP_TIMEOUT_MS;
  }

  /**
   * @inheritdoc
   *
   * Entry point 2 of 3. `fresh: true` always bypasses a cached success, which
   * is what makes `browser check` a real diagnosis rather than a replay.
   */
  async check(
    installation: ResolvedBrowserInstallation,
    options: CompatibilityCheckOptions,
  ): Promise<CompatibilityResult> {
    return (await this.decide(installation, options)).result;
  }

  /**
   * @inheritdoc
   *
   * The one body {@link check} and {@link ensureCompatible} are projections of.
   * There is no second cache lookup and no second probe call site here — only
   * the extra sentence about which of the two produced the answer.
   */
  async decide(
    installation: ResolvedBrowserInstallation,
    options: CompatibilityCheckOptions,
  ): Promise<CompatibilityDecision> {
    if (!options.fresh) {
      const cached = await this.readCached(installation, options.profile);
      if (cached.state === 'evidence') return { result: cached.result, evidenceSource: 'cache' };
    }
    return {
      result: await this.runProbe(
        installation,
        options.profile,
        { kind: 'external' },
        options.signal,
      ),
      evidenceSource: 'probe',
    };
  }

  /** @inheritdoc Never launches. */
  readCached(
    installation: ResolvedBrowserInstallation,
    profile: ProbeProfile,
  ): Promise<CompatibilityEvidenceState> {
    return this.cache.read(installation, profile);
  }

  /**
   * Entry point 1 of 3: the resolver's launch path.
   *
   * Probes only when no valid cached evidence exists, so an ordinary run pays
   * for a synthetic browser once per executable identity rather than every time.
   */
  async ensureCompatible(
    installation: ResolvedBrowserInstallation,
    profile: ProbeProfile,
    signal?: AbortSignal,
  ): Promise<CompatibilityResult> {
    const decision = await this.decide(installation, {
      profile,
      fresh: false,
      ...(signal ? { signal } : {}),
    });
    return decision.result;
  }

  /**
   * Entry point 3 of 3: probing a candidate an install/update is writing.
   *
   * It accepts no task URL, no launch options, and no user profile; it validates
   * live ownership and canonical containment before spawning; it bypasses only
   * this operation's own mutation exclusion; and it publishes no readiness and
   * takes no ordinary reservation.
   *
   * @internal
   */
  async probeManagedCandidate(
    permit: CandidateProbePermit,
    profile: ProbeProfile,
    signal?: AbortSignal,
  ): Promise<CompatibilityResult> {
    await assertCandidateProbePermit(permit, {
      candidateRootRelative: permit.candidateRootRelative,
      executablePath: permit.executablePath,
    });

    const candidateRoot = join(this.managedRoot(), permit.candidateRootRelative);
    const canonicalRoot = await canonicalize(candidateRoot);
    const canonicalExecutable = await canonicalize(permit.executablePath);
    if (
      canonicalRoot === null ||
      canonicalExecutable === null ||
      !isInside(canonicalExecutable, canonicalRoot)
    ) {
      throw new ManagedCoordinationError({
        reason: 'invalid-permit',
        detail: `The candidate executable is not contained in ${permit.candidateRootRelative}.`,
        remediation: 'Probe only the executable inside the candidate this operation owns.',
      });
    }

    const identified = await this.identify(permit.executablePath);
    if (identified === null) {
      throw new ManagedCoordinationError({
        reason: 'invalid-permit',
        detail: `The candidate executable at ${permit.executablePath} could not be identified.`,
        remediation: 'Re-run the installation; the extracted build looks incomplete.',
      });
    }

    const installation: ResolvedBrowserInstallation = {
      ...identified,
      ownership: 'managed',
      requestedSelection: { source: 'managed', executablePath: null },
      selectionOrigin: 'invocation',
      selectionReason: 'managed-explicit',
      channel: 'stable',
      managedIdentity: null,
    };
    return this.runProbe(installation, profile, { kind: 'candidate-probe', permit }, signal);
  }

  /**
   * The one probe body. All three entry points funnel here.
   *
   * @internal Public so tests can assert single-instance reuse by spying on the
   * instance itself — an outer decorator cannot observe internal `this.` calls.
   */
  async runProbe(
    installation: ResolvedBrowserInstallation,
    profile: ProbeProfile,
    ownership: Extract<LaunchOwnership, { kind: 'external' } | { kind: 'candidate-probe' }>,
    signal?: AbortSignal,
  ): Promise<CompatibilityResult> {
    const rows = requiredCapabilities(profile, this.descriptor);
    const syntheticProfile = await this.profileStore.resolve({ kind: 'ephemeral' });

    let launched: Awaited<ReturnType<typeof launchResolvedChrome>> | null = null;
    let session: SyntheticSession | null = null;
    try {
      const options = parseLaunchOptions({
        // Always headless, always the probe's own ephemeral profile, never the
        // caller's session and never a user-visible window.
        profile: { kind: 'ephemeral' },
        headless: true,
        startupTimeoutMs: this.startupTimeoutMs,
      });
      try {
        launched = await this.launch(options, installation, syntheticProfile, ownership, {
          ...(signal ? { signal } : {}),
        });
      } catch (cause) {
        return await this.recordFailure(
          installation,
          profile,
          rows.map((row) => ({ capability: row.id, status: 'not-run' as const, reason: null })),
          await this.classifyLaunchFailure(installation, cause),
        );
      }

      session = new SyntheticSession(launched.browser, signal);
      const evidence = await this.runCapabilities(rows, session, signal);
      const failed = evidence.filter((entry) => entry.status === 'failed');
      if (failed.length > 0) {
        return await this.recordFailure(installation, profile, evidence, {
          failureClass: 'capability-failure',
          remediation: `This browser does not support ${failed
            .map((entry) => entry.capability)
            .join(
              ', ',
            )}. Install a current Chrome or Chromium, or run \`yantra browser install\` to use a Yantra-managed build.`,
        });
      }
      return await this.record(installation, profile, evidence, {
        status: 'passed',
        pairing: pairingFor(installation.version, this.descriptor),
      });
    } finally {
      // The synthetic session and its profile are closed on success and on
      // failure alike — including when a capability threw partway through.
      await session?.dispose();
      if (launched !== null) await launched.shutdown().catch(() => undefined);
      await this.profileStore
        .cleanupEphemeral(syntheticProfile.absolutePath)
        .catch((error: unknown) =>
          this.logger.warn({ err: error }, 'failed to remove the synthetic probe profile'),
        );
    }
  }

  /**
   * Runs each required row in dependency order.
   *
   * A row whose prerequisite failed is reported `not-run` naming that
   * prerequisite, so the output says what to fix rather than listing a cascade
   * of failures with one real cause.
   */
  private async runCapabilities(
    rows: readonly { id: CapabilityId; dependsOn: readonly CapabilityId[] }[],
    session: SyntheticSession,
    signal?: AbortSignal,
  ): Promise<readonly CapabilityEvidence[]> {
    const outcomes = new Map<CapabilityId, CapabilityEvidence>();
    for (const row of rows) {
      signal?.throwIfAborted();
      const blocker = row.dependsOn.find(
        (id) => outcomes.get(id) !== undefined && outcomes.get(id)!.status !== 'passed',
      );
      if (blocker !== undefined) {
        outcomes.set(row.id, {
          capability: row.id,
          status: 'not-run',
          reason: `prerequisite "${blocker}" did not pass`,
        });
        continue;
      }
      const runner = this.runners[row.id];
      try {
        await withTimeout(
          runner(session.context),
          CAPABILITY_TIMEOUT_MS,
          `"${row.id}" did not complete within ${CAPABILITY_TIMEOUT_MS}ms`,
        );
        outcomes.set(row.id, { capability: row.id, status: 'passed', reason: null });
      } catch (error) {
        outcomes.set(row.id, {
          capability: row.id,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return rows.map((row) => outcomes.get(row.id)!);
  }

  /**
   * Classifies why a probe could not even start.
   *
   * Missing browser runtime libraries are the most common managed-Chrome
   * failure on a minimal Linux host or container image, and they are a
   * different problem from an incompatible build. Remediation is rendered from
   * the installation's own `deb.deps` so the message names actual packages —
   * never "use a different Chrome", because the user this exists for has none.
   */
  private async classifyLaunchFailure(
    installation: ResolvedBrowserInstallation,
    cause: unknown,
  ): Promise<{ failureClass: ProbeFailureClass; remediation: string }> {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (!looksLikeMissingLibraries(detail)) {
      return {
        failureClass: 'launch-environment',
        remediation: `The browser at ${installation.canonicalPath} could not be started: ${detail}. Verify the installation, or run \`yantra browser install\` to provision a Yantra-managed build.`,
      };
    }

    const packages = parseDebDeps(await this.readDebDeps(installation.canonicalPath));
    if (packages.length === 0) {
      return {
        failureClass: 'missing-runtime-libraries',
        remediation: `This browser is missing shared libraries it needs to start: ${detail}. Install the browser's runtime library packages for your distribution and retry.`,
      };
    }
    return {
      failureClass: 'missing-runtime-libraries',
      remediation: `This browser is missing shared libraries it needs to start. Install its runtime dependencies and retry — on Debian/Ubuntu: sudo apt-get install -y ${packages.join(' ')}. Loader output: ${detail}`,
    };
  }

  private recordFailure(
    installation: ResolvedBrowserInstallation,
    profile: ProbeProfile,
    capabilities: readonly CapabilityEvidence[],
    failure: { failureClass: ProbeFailureClass; remediation: string },
  ): Promise<CompatibilityResult> {
    return this.record(installation, profile, capabilities, {
      status: 'failed',
      failureClass: failure.failureClass,
      remediation: failure.remediation,
    });
  }

  private async record(
    installation: ResolvedBrowserInstallation,
    profile: ProbeProfile,
    capabilities: readonly CapabilityEvidence[],
    verdict: CompatibilityResult['verdict'],
  ): Promise<CompatibilityResult> {
    const result: CompatibilityResult = {
      schemaVersion: 1,
      identity: {
        canonicalPath: installation.canonicalPath,
        version: installation.version,
        majorVersion: installation.majorVersion,
        platform: installation.platform,
        architecture: installation.architecture,
        statFingerprint: installation.statFingerprint,
      },
      driverVersion: this.descriptor.driverVersion,
      testedBuild: this.descriptor.testedBuild,
      probeRevision: this.descriptor.probeRevision,
      capabilityTableHash: capabilityTableHash(this.descriptor),
      profile,
      checkedAt: this.clock().toISOString(),
      capabilities,
      verdict,
    };
    await this.cache.write(result);
    this.logger.info(
      {
        browserVersion: result.identity.version,
        driverVersion: result.driverVersion,
        testedBuild: result.testedBuild,
        probeRevision: result.probeRevision,
        profile,
        verdict: verdict.status,
        pairing: verdict.status === 'passed' ? verdict.pairing : null,
      },
      'local browser compatibility evidence recorded',
    );
    return result;
  }
}

// ---------------------------------------------------------------------------
// Synthetic session
// ---------------------------------------------------------------------------

/** Owns the one synthetic page and CDP session, and tears both down. */
class SyntheticSession {
  readonly context: ProbeContext;

  private readonly browser: Browser;
  private pagePromise: Promise<PuppeteerPage> | null = null;
  private cdpPromise: Promise<CDPSession> | null = null;

  constructor(browser: Browser, signal?: AbortSignal) {
    this.browser = browser;
    this.context = {
      browser,
      page: () => this.resolvePage(),
      cdp: () => this.resolveCdp(),
      signal,
    };
  }

  /** Reuses the initial about:blank tab rather than opening a second one. */
  private resolvePage(): Promise<PuppeteerPage> {
    this.pagePromise ??= (async () => {
      const existing = await this.browser.pages();
      return existing[0] ?? (await this.browser.newPage());
    })();
    return this.pagePromise;
  }

  private resolveCdp(): Promise<CDPSession> {
    this.cdpPromise ??= this.resolvePage().then((page) => page.createCDPSession());
    return this.cdpPromise;
  }

  async dispose(): Promise<void> {
    if (this.cdpPromise !== null) {
      await this.cdpPromise.then((cdp) => cdp.detach()).catch(() => undefined);
    }
    if (this.pagePromise !== null) {
      await this.pagePromise.then((page) => page.close()).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Loader messages that mean "a shared object is missing", not "wrong version". */
function looksLikeMissingLibraries(detail: string): boolean {
  return /error while loading shared libraries|cannot open shared object file|libnss3|libgbm|libatk|libasound/i.test(
    detail,
  );
}

/** Upstream ships `deb.deps` next to the extracted executable. */
async function readDebDepsFile(executablePath: string): Promise<string | null> {
  try {
    return await readFile(join(dirname(executablePath), 'deb.deps'), 'utf8');
  } catch {
    return null;
  }
}

/** `libnss3 (>= 2:3.31), libgbm1 (>= 17.1.0)` -> `['libnss3', 'libgbm1']`. */
export function parseDebDeps(contents: string | null): readonly string[] {
  if (contents === null) return [];
  return [
    ...new Set(
      contents
        .split(/[,\n]/u)
        .map((entry) => entry.trim().split(/\s|\(/u)[0]?.trim() ?? '')
        .filter((name) => name.length > 0 && /^[a-z0-9][a-z0-9+.-]*$/i.test(name)),
    ),
  ];
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
