/**
 * RecordingSession — the Node-side orchestrator for browser recording.
 *
 * Owns the browser handle, CDP binding, overlay injection, redactor,
 * popup handler, idle watcher, and draft builder.
 *
 * Lifecycle: idle → recording → (stopping | aborted) → stopped
 *
 * @example
 * const session = new RecordingSession({ store, redactor, cacheRoot });
 * const handle = await session.start('bank-statement');
 * // ... user interacts with browser ...
 * const { draftPath } = await session.stop('user');
 */

import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  CapturedAction,
  NavigateAction,
  RecordingMetadata,
  StopReason,
} from '@yantra/protocol';
import type { CDPSession, Page as PuppeteerPage } from 'puppeteer-core';

import { BrowserCompatibilityError } from '../../browser/errors.js';
import type {
  BrowserRuntimeServices,
  BrowserSelection,
  ResolvedBrowserInstallation,
} from '../../browser/installation-types.js';
import { parseLaunchOptions } from '../../browser/launch-options.js';
import { launchResolvedChrome, type OwnedBrowserProcess } from '../../browser/launcher.js';
import type { OwnedManagedUseReservation } from '../../browser/managed-coordination.js';
import { cacheDir } from '../../browser/paths.js';
import { createLocalBrowserRuntimeServices } from '../../browser/runtime-services.js';

import { normalizeCandidateChain } from './candidate-resolver.js';
import { assembleDraft, computeDwellPerPage } from './draft-builder.js';
import { IdleWatcher, DEFAULT_IDLE_TIMEOUT_MS } from './idle-watcher.js';
import { PopupHandler } from './popup-handler.js';
import { DefaultCaptureRedactor } from './redactor.js';
import type { CaptureRedactor } from './redactor.js';
import { FileSystemRecordingStore } from './store.js';
import type { RecordingStore } from './store.js';
import type {
  AbortCause,
  RecordingSessionEvent,
  RecordingState,
  RawInPagePayload,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Generates a lexicographically time-ordered recording ID (ULID-compatible format). */
function generateRecordingId(): string {
  const ts = Date.now().toString(36).toUpperCase().padStart(9, '0');
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((b) => b.toString(36).toUpperCase().padStart(2, '0'))
    .join('')
    .slice(0, 16);
  return ts + rnd;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function readOverlayBundle(): Promise<string> {
  const bundlePath = join(__dirname, '..', '..', '..', 'dist', 'recorder-overlay.iife.js');
  try {
    return await readFile(bundlePath, 'utf8');
  } catch {
    // Development fallback — return a minimal no-op so the session can still start
    return `
      window.__yantraRecorder = { state: { status: 'recording', actionCount: 0 }, updateCount: function(){}, showToast: function(){} };
      window.__yantraRecorderEmit = window.__yantraRecorderEmit || function(){};
      console.warn('[yantra] recorder overlay bundle not found — run: pnpm --filter @yantra/core build:recorder-overlay');
    `;
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RecordingStartOptions {
  /** Idle timeout in ms before the user is prompted to stop. Default: 5 min. */
  idleTimeoutMs?: number;
  /** When true, the ephemeral profile dir is preserved on stop. Default: false. */
  keepProfile?: boolean;
  /** The one semantic browser choice, identical to the provider's. */
  browserSelection?: BrowserSelection;
  /** Startup allowance for the recording browser. */
  startupTimeoutMs?: number;
}

export interface RecordingHandle {
  readonly recordingId: string;
  readonly recordingDir: string;
  /** Stream of all session events (progress, popups, idle prompts, etc.). */
  readonly events: EventEmitter;
  /** Resolves when the recording ends (stop or abort). */
  readonly done: Promise<{ draftPath: string; stopReason: StopReason }>;
}

// ---------------------------------------------------------------------------
// RecordingSession
// ---------------------------------------------------------------------------

export class RecordingSession {
  private readonly store: RecordingStore;
  private readonly redactor: CaptureRedactor;

  // Set during start()
  private recordingId: string | null = null;
  private recordingDir: string | null = null;
  private workflowNameHint: string | null = null;
  private startedAt: string | null = null;
  private state: RecordingState = 'idle';

  // Browser handles
  private launched: OwnedBrowserProcess | null = null;
  private reservation: OwnedManagedUseReservation | null = null;
  private mainPage: PuppeteerPage | null = null;
  private mainPageCDP: CDPSession | null = null;
  private browserCDP: CDPSession | null = null;
  private mainTargetId: string | null = null;

  // Module instances
  private idleWatcher: IdleWatcher | null = null;
  private popupHandler: PopupHandler | null = null;
  private readonly sessionListeners = new Map<
    CDPSession,
    {
      readonly bindingCalled: (params: unknown) => void;
      readonly frameNavigated: (params: unknown) => void;
      readonly executionContextCreated: (params: unknown) => void;
    }
  >();

  // Action accumulator
  private actions: CapturedAction[] = [];
  private lastNavigationUrl: string | null = null;
  private lastClickTs: number | null = null;
  private lastClickActionIndex: number | null = null;

  // Cross-origin iframe tracking
  private unrecordedFrameOrigins = new Set<string>();

  // Metadata fields
  private chromeVersion = 'unknown';
  private chromeMajor = 0;
  private yantraVersion = '0.0.1';

  // Handle internals
  private eventEmitter = new EventEmitter();
  private doneResolve: ((val: { draftPath: string; stopReason: StopReason }) => void) | null = null;
  private doneReject: ((err: Error) => void) | null = null;
  private keepProfile = false;

  private readonly services: BrowserRuntimeServices;
  private readonly launch: typeof launchResolvedChrome;

  constructor(deps?: {
    store?: RecordingStore;
    redactor?: CaptureRedactor;
    /** The same selection/compatibility/coordination seam every caller uses. */
    services?: BrowserRuntimeServices;
    /** External boundary: the shared launch path. */
    launch?: typeof launchResolvedChrome;
  }) {
    this.store = deps?.store ?? new FileSystemRecordingStore(cacheDir());
    this.redactor = deps?.redactor ?? new DefaultCaptureRedactor();
    this.services = deps?.services ?? createLocalBrowserRuntimeServices();
    this.launch = deps?.launch ?? launchResolvedChrome;
  }

  /** The live Puppeteer browser, or null before startup and after teardown. */
  private get browser() {
    return this.launched?.browser ?? null;
  }

  // ---------------------------------------------------------------------------
  // TASK-008: start
  // ---------------------------------------------------------------------------

  /**
   * Start a new recording session.
   *
   * Launches Chrome in headful mode, injects the overlay, attaches CDP bindings,
   * and transitions the session to `recording`.
   *
   * @param workflowName - Human-readable name for the workflow being recorded
   * @param opts - Optional configuration overrides
   * @returns A `RecordingHandle` with the event stream and done promise
   */
  async start(workflowName: string, opts: RecordingStartOptions = {}): Promise<RecordingHandle> {
    if (this.state !== 'idle') {
      throw new Error(`RecordingSession.start() called in invalid state: ${this.state}`);
    }

    this.keepProfile = opts.keepProfile ?? false;
    this.recordingId = generateRecordingId();
    this.workflowNameHint = workflowName;
    this.startedAt = nowIso();

    // Create recording dir + profile dir
    const { recordingDir } = await this.store.create(this.recordingId, workflowName);
    this.recordingDir = recordingDir;

    // Read yantra version
    try {
      const pkgJson = JSON.parse(
        await readFile(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
      ) as { version?: string };
      this.yantraVersion = pkgJson.version ?? '0.0.1';
    } catch {
      // Non-fatal
    }

    const profileDir = join(recordingDir, 'profile');

    // Everything from here on is rollback-protected: a failed startup must not
    // leave a browser, a CDP session, or a managed reservation behind, and must
    // not pretend recording began.
    try {
      const installation = await this.resolveRecordingBrowser(opts);
      this.chromeVersion = installation.version;
      this.chromeMajor = installation.majorVersion;

      await this.launchRecordingBrowser(installation, profileDir, opts);
      await this.initializeRecording(workflowName, recordingDir, opts);
    } catch (error) {
      await this.rollbackStartup();
      throw error;
    }

    const donePromise = new Promise<{ draftPath: string; stopReason: StopReason }>(
      (resolve, reject) => {
        this.doneResolve = resolve;
        this.doneReject = reject;
      },
    );

    return {
      recordingId: this.recordingId,
      recordingDir,
      events: this.eventEmitter,
      done: donePromise,
    };
  }

  /**
   * Resolves and verifies the browser this recording will use.
   *
   * Recording needs the automation capability set *plus* the recorder's own
   * binding, preload, and Page-domain rows, so automation evidence alone can
   * never approve it — and the check happens before any recording
   * initialization or user navigation.
   */
  private async resolveRecordingBrowser(
    opts: RecordingStartOptions,
  ): Promise<ResolvedBrowserInstallation> {
    // One resolution algorithm, shared with every other caller: the recorder
    // hands the resolver a selection and nothing else.
    const resolution = await this.services.resolver.resolve(opts.browserSelection);
    if (resolution.status === 'unavailable') throw resolution.error;
    const installation = resolution.installation;

    if (installation.ownership === 'managed' && installation.managedIdentity !== null) {
      this.reservation = (await this.services.coordinator.reserveUse(
        installation.managedIdentity,
      )) as OwnedManagedUseReservation;
    }

    const compatibility = await this.services.compatibility.check(installation, {
      profile: 'recorder',
      fresh: false,
    });
    if (compatibility.verdict.status === 'failed') {
      throw new BrowserCompatibilityError({
        failureClass: compatibility.verdict.failureClass,
        profile: 'recorder',
        executablePath: installation.canonicalPath,
        version: installation.version,
        capabilities: compatibility.capabilities,
        remediation: compatibility.verdict.remediation,
      });
    }
    return installation;
  }

  /** Starts the visible recording browser through the shared launch path. */
  private async launchRecordingBrowser(
    installation: ResolvedBrowserInstallation,
    profileDir: string,
    opts: RecordingStartOptions,
  ): Promise<void> {
    const launchOptions = parseLaunchOptions({
      // Recording is deliberately visible, and always uses the Yantra-owned
      // recording profile — never a personal Chrome profile root.
      profile: { kind: 'explicit', absolutePath: profileDir },
      headless: false,
      viewport: null,
      ...(opts.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: opts.startupTimeoutMs }),
    });

    this.launched = await this.launch(
      launchOptions,
      installation,
      { absolutePath: profileDir, kind: 'explicit', createdNow: true },
      this.reservation === null
        ? { kind: 'external' }
        : { kind: 'managed', reservation: this.reservation },
    );

    // Browser-level CDP for target lifecycle
    this.browserCDP = await this.browser!.target().createCDPSession();
  }

  /** Everything after the browser exists: pages, bindings, overlay, watchers. */
  private async initializeRecording(
    workflowName: string,
    recordingDir: string,
    opts: RecordingStartOptions,
  ): Promise<void> {
    // Open main page
    this.mainPage = await this.browser!.newPage();
    this.mainPageCDP = await this.mainPage.createCDPSession();

    // Resolve the main page target ID via CDP (puppeteer-core no longer exposes
    // `target.targetInfo()`; we ask the page's own CDP session for its target).
    const targetInfoResp = (await this.mainPageCDP.send('Target.getTargetInfo')) as {
      targetInfo: { targetId: string };
    };
    this.mainTargetId = targetInfoResp.targetInfo.targetId;

    // Get Chrome version via CDP
    try {
      const versionInfo = (await this.mainPageCDP.send('Browser.getVersion')) as {
        product: string;
      };
      const match = /Chrome\/(\d+)/.exec(versionInfo.product ?? '');
      if (match?.[1]) {
        this.chromeMajor = parseInt(match[1], 10);
        this.chromeVersion = versionInfo.product;
      }
    } catch {
      // Non-fatal
    }

    // Register CDP binding (before injecting script)
    await this.installOverlayOnSession(this.mainPageCDP);

    // Frame attachment for cross-origin detection (TASK-006a)
    this.mainPageCDP.on('Page.frameAttached', (params: unknown) => {
      void this.onFrameAttached(params as FrameAttachedParams);
    });

    // Crash detection (TASK-013)
    this.browser!.on('disconnected', () => {
      if (this.state === 'recording' || this.state === 'paused') {
        void this.abort('browser_disconnected');
      }
    });

    // Setup popup handler (TASK-006)
    if (this.recordingId === null) {
      throw new Error('recordingId is unexpectedly null after session start');
    }
    this.popupHandler = new PopupHandler(this.browserCDP!, this.mainTargetId, this.recordingId, {
      onEvent: (event) => this.emit(event),
      onPopupSession: (session, _targetId) => this.installOverlayOnSession(session),
      onPopupSessionClosed: (session) => this.removeOverlaySessionListeners(session),
      onUnrecordedOrigin: (origin) => {
        this.unrecordedFrameOrigins.add(origin);
      },
    });
    await this.popupHandler.install();

    // Setup idle watcher (TASK-012)
    this.idleWatcher = new IdleWatcher({
      onIdleTimeout: () => {
        if (this.state === 'recording') {
          this.emit({
            kind: 'idle_timeout_prompt',
            recordingId: this.recordingId!,
            ts: nowIso(),
          });
        }
      },
    });
    this.idleWatcher.start(opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);

    this.state = 'recording';

    this.emit({
      kind: 'recording_started',
      recordingId: this.recordingId,
      workflowNameHint: workflowName,
      recordingDir,
      ts: this.startedAt!,
    });
  }

  /**
   * Undoes exactly what a failed startup acquired.
   *
   * Only resources this call owns are released: its own CDP sessions and
   * listeners, its popup and idle watchers, its browser process, and its
   * managed reservation. The recording directory and the draft the caller may
   * later inspect are left alone — a failed startup cleans up without
   * pretending recording began.
   */
  private async rollbackStartup(): Promise<void> {
    this.idleWatcher?.stop();
    this.idleWatcher = null;
    try {
      await this.popupHandler?.dispose();
    } catch {
      // A popup handler that never installed has nothing to release.
    }
    this.popupHandler = null;
    await this.cleanupRecorderSessions();
    try {
      await this.browserCDP?.detach();
    } catch {
      // The transport may already be gone; that is the desired end state.
    }
    this.browserCDP = null;
    this.mainPage = null;
    this.mainPageCDP = null;
    this.mainTargetId = null;
    if (this.launched !== null) {
      // Closes and awaits process exit, then releases the managed reservation.
      await this.launched.shutdown().catch(() => undefined);
    } else {
      // A reservation taken before the browser existed still has to be given
      // back, with the proof that nothing was ever spawned under it.
      await this.reservation?.markNeverSpawned().catch(() => undefined);
    }
    this.launched = null;
    this.reservation = null;
    this.state = 'idle';
  }

  // ---------------------------------------------------------------------------
  // TASK-009: stop
  // ---------------------------------------------------------------------------

  /**
   * Stop the recording cleanly.
   *
   * Flushes pending state, writes `draft.json` atomically, closes Chrome,
   * and destroys the ephemeral profile (unless `keepProfile`).
   *
   * @param reason - Why the recording is stopping
   * @returns Path to the written `draft.json`
   */
  async stop(reason: StopReason): Promise<{ draftPath: string }> {
    if (this.state !== 'recording' && this.state !== 'paused') {
      throw new Error(`RecordingSession.stop() called in invalid state: ${this.state}`);
    }

    this.state = 'stopping';
    this.idleWatcher?.stop();

    const stoppedAt = nowIso();
    const draftPath = await this.writeDraft(stoppedAt, reason);

    await this.cleanupRecorderSessions();
    await this.closeBrowser({ force: false });
    await this.store.destroy(this.recordingId!, { keepProfile: this.keepProfile });

    this.state = 'stopped';

    this.emit({
      kind: 'recording_stopped',
      recordingId: this.recordingId!,
      draftPath,
      stopReason: reason,
      ts: stoppedAt,
    });

    this.doneResolve?.({ draftPath, stopReason: reason });

    return { draftPath };
  }

  // ---------------------------------------------------------------------------
  // TASK-013: abort (crash / error handling)
  // ---------------------------------------------------------------------------

  /**
   * Abort the recording due to a crash or unrecoverable error.
   *
   * Preserves whatever actions were captured up to this point.
   * Profile dir is kept for post-mortem inspection.
   *
   * @param cause - What triggered the abort
   * @returns Path to the partial `draft.json` (stop_reason: 'crash')
   */
  async abort(cause: AbortCause): Promise<{ draftPath: string }> {
    if (this.state === 'stopped' || this.state === 'aborted') {
      return { draftPath: join(this.recordingDir ?? '', 'draft.json') };
    }

    this.state = 'aborted';
    this.idleWatcher?.stop();

    const stoppedAt = nowIso();
    let draftPath = join(this.recordingDir ?? '', 'draft.json');

    try {
      draftPath = await this.writeDraft(stoppedAt, 'crash');
    } catch {
      // Even draft writing failed — nothing more we can do
    }

    // Force-close browser
    await this.cleanupRecorderSessions();
    await this.closeBrowser({ force: true });

    // Keep profile on crash for post-mortem (ignore keepProfile setting)
    // NOTE: we do NOT call store.destroy here

    this.emit({
      kind: 'recording_aborted',
      recordingId: this.recordingId!,
      cause,
      lastActionIndex: this.actions.length - 1,
      recordingDir: this.recordingDir!,
      ts: stoppedAt,
    });

    this.doneResolve?.({ draftPath, stopReason: 'crash' });

    return { draftPath };
  }

  /** Reset the idle timer (called by the CLI when user declines the idle prompt). */
  resetIdleTimer(): void {
    this.idleWatcher?.ping();
  }

  // ---------------------------------------------------------------------------
  // In-page event handling (TASK-002 Node side)
  // ---------------------------------------------------------------------------

  private onBindingCalled(params: { name: string; payload: string }): void {
    if (params.name !== '__yantraRecorderEmit') return;
    if (this.state !== 'recording' && this.state !== 'paused') return;

    let payload: RawInPagePayload;
    try {
      payload = JSON.parse(params.payload) as RawInPagePayload;
    } catch {
      return; // malformed payload — skip
    }

    void this.processInPagePayload(payload).catch((err: unknown) => {
      this.emit({
        kind: 'recording_degraded',
        recordingId: this.recordingId!,
        reason: `action processing error: ${String(err)}`,
        ts: nowIso(),
      });
    });
  }

  private async processInPagePayload(payload: RawInPagePayload): Promise<void> {
    if (payload.kind === 'navigate') return; // handled by CDP Page.frameNavigated

    const ts = new Date(payload.ts).toISOString();
    const xpath = payload.descriptor?.xpath_for_debug ?? '/unknown';
    const candidateChain = normalizeCandidateChain(payload.candidate_chain, xpath);

    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- payload.descriptor crosses the CDP boundary as `any`; redact is the single trusted sanitizer */
    const descriptor = payload.descriptor as any;
    let rawAction: any;

    if (payload.kind === 'click') {
      rawAction = {
        kind: 'click',
        element_descriptor: descriptor,
        candidate_chain: candidateChain,
        ts,
        url_before: payload.url,
        url_after: null,
      };
      // Track for click → navigate correlation (TASK-005)
      this.lastClickTs = payload.ts;
      this.lastClickActionIndex = this.actions.length;
    } else if (payload.kind === 'fill' || payload.kind === 'keydown_enter') {
      rawAction = {
        kind: 'fill',
        element_descriptor: descriptor,
        candidate_chain: candidateChain,
        ts,
        url_before: payload.url,
        url_after: null,
        raw_value: payload.raw_value ?? '',
        value_length: payload.value_length,
        input_type: payload.input_type ?? 'other',
      };
    } else {
      return;
    }

    // SECURITY: redact fill values before any persistence
    const action = this.redactor.redact(rawAction);
    /* eslint-enable */

    await this.store.appendAction(this.recordingId!, action);
    this.actions.push(action);
    this.idleWatcher?.ping();

    this.lastNavigationUrl ??= payload.url;

    this.emit({
      kind: 'capture_emitted',
      recordingId: this.recordingId!,
      actionIndex: this.actions.length - 1,
      actionKind: action.kind,
      url: payload.url,
      ts,
    });
  }

  // ---------------------------------------------------------------------------
  // Navigation capture (TASK-005)
  // ---------------------------------------------------------------------------

  private onFrameNavigated(params: FrameNavigatedParams): void {
    const frame = params.frame;
    if (frame.parentId) return; // only main frame navigations

    const urlAfter = frame.url;
    const urlBefore = this.lastNavigationUrl ?? 'about:blank';

    if (urlAfter === urlBefore) return;

    // Classify navigation kind
    const now = Date.now();
    const clickAgeMs = this.lastClickTs !== null ? now - this.lastClickTs : Infinity;
    const isRecentClick = clickAgeMs < 1000;

    let navigationKind: NavigateAction['navigation_kind'];
    let triggeredByActionIndex: number | null = null;

    if (isRecentClick && this.lastClickActionIndex !== null) {
      navigationKind = 'user_click';
      triggeredByActionIndex = this.lastClickActionIndex;
    } else if (urlAfter.startsWith('about:') || urlAfter.startsWith('chrome:')) {
      navigationKind = 'programmatic';
    } else {
      navigationKind = 'address_bar';
    }

    const action: CapturedAction = {
      kind: 'navigate',
      ts: nowIso(),
      url_before: urlBefore,
      url_after: urlAfter,
      navigation_kind: navigationKind,
      triggered_by_action_index: triggeredByActionIndex,
    };

    this.lastNavigationUrl = urlAfter;

    // Set the main frame origin for cross-origin detection
    this.popupHandler?.setMainFrameOrigin(urlAfter);

    void this.store
      .appendAction(this.recordingId!, action)
      .then(() => {
        this.actions.push(action);
        this.idleWatcher?.ping();
        this.emit({
          kind: 'navigation_captured',
          recordingId: this.recordingId!,
          url_before: urlBefore,
          url_after: urlAfter,
          navigation_kind: navigationKind,
          ts: action.ts,
        });
      })
      .catch(() => {
        /* non-fatal */
      });
  }

  // ---------------------------------------------------------------------------
  // Cross-origin iframe detection (TASK-006a)
  // ---------------------------------------------------------------------------

  private onFrameAttached(params: FrameAttachedParams): Promise<void> {
    if (!params.parentFrameId) return Promise.resolve();
    // Frame URL not immediately available at attach time — check on frameNavigated
    void params;
    return Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Popup support — install overlay on new target
  // ---------------------------------------------------------------------------

  private async installOverlayOnSession(session: CDPSession): Promise<void> {
    if (this.sessionListeners.has(session)) return;
    const overlayCode = await readOverlayBundle();
    const bindingCalled = (params: unknown): void => {
      this.onBindingCalled(params as { name: string; payload: string });
    };
    const frameNavigated = (params: unknown): void => {
      const navigation = params as FrameNavigatedParams;
      this.onFrameNavigated(navigation);
      if (!navigation.frame.parentId) {
        void this.evaluateOverlayOnSession(session, overlayCode).catch((error: unknown) => {
          this.emit({
            kind: 'recording_degraded',
            recordingId: this.recordingId!,
            reason: `recorder overlay reinjection failed: ${String(error)}`,
            ts: nowIso(),
          });
        });
      }
    };
    const executionContextCreated = (params: unknown): void => {
      const created = params as ExecutionContextCreatedParams;
      if (created.context.auxData?.isDefault !== true) return;
      void this.evaluateOverlayOnSession(session, overlayCode, created.context.id).catch(
        (error: unknown) => {
          if (session.detached) return;
          this.emit({
            kind: 'recording_degraded',
            recordingId: this.recordingId!,
            reason: `recorder overlay context injection failed: ${String(error)}`,
            ts: nowIso(),
          });
        },
      );
    };
    session.on('Runtime.bindingCalled', bindingCalled);
    session.on('Page.frameNavigated', frameNavigated);
    session.on('Runtime.executionContextCreated', executionContextCreated);
    this.sessionListeners.set(session, { bindingCalled, frameNavigated, executionContextCreated });

    try {
      await session.send('Page.enable');
      await session.send('Runtime.enable');
      await session.send('Runtime.addBinding', { name: '__yantraRecorderEmit' });
      await session.send('Page.addScriptToEvaluateOnNewDocument', { source: overlayCode });
      await this.evaluateOverlayOnSession(session, overlayCode);
    } catch (error) {
      this.removeOverlaySessionListeners(session);
      throw error;
    }
  }

  private async evaluateOverlayOnSession(
    session: CDPSession,
    overlayCode: string,
    contextId?: number,
  ): Promise<void> {
    const result = await session.send('Runtime.evaluate', {
      expression: overlayCode,
      awaitPromise: true,
      ...(contextId === undefined ? {} : { contextId }),
    });
    if (result.exceptionDetails) {
      throw new Error(`Recorder overlay injection failed: ${result.exceptionDetails.text}`);
    }
  }

  private removeOverlaySessionListeners(session: CDPSession): void {
    const listeners = this.sessionListeners.get(session);
    if (!listeners) return;
    session.off('Runtime.bindingCalled', listeners.bindingCalled);
    session.off('Page.frameNavigated', listeners.frameNavigated);
    session.off('Runtime.executionContextCreated', listeners.executionContextCreated);
    this.sessionListeners.delete(session);
  }

  private async cleanupRecorderSessions(): Promise<void> {
    await this.popupHandler?.dispose();
    this.popupHandler = null;
    for (const session of [...this.sessionListeners.keys()]) {
      this.removeOverlaySessionListeners(session);
    }
    const mainPageCDP = this.mainPageCDP;
    const browserCDP = this.browserCDP;
    this.mainPageCDP = null;
    this.browserCDP = null;
    await Promise.allSettled([
      mainPageCDP?.detach() ?? Promise.resolve(),
      browserCDP?.detach() ?? Promise.resolve(),
    ]);
  }

  // ---------------------------------------------------------------------------
  // TASK-014: Draft assembly with metadata
  // ---------------------------------------------------------------------------

  private async writeDraft(stoppedAt: string, stopReason: StopReason): Promise<string> {
    const dwellPerPage = computeDwellPerPage(this.actions);
    const initialUrl =
      this.actions.find((a) => a.kind === 'navigate')?.url_after ??
      this.lastNavigationUrl ??
      'about:blank';

    const metadata: RecordingMetadata = {
      start_ts: this.startedAt!,
      end_ts: stoppedAt,
      os: {
        platform: platform(),
        release: release(),
        arch: arch(),
      },
      chrome_version: this.chromeVersion,
      chrome_major: this.chromeMajor,
      yantra_version: this.yantraVersion,
      initial_url: initialUrl,
      capture_count: this.actions.length,
      dwell_per_page: dwellPerPage,
      stop_reason: stopReason,
      unrecorded_frame_origins: [...this.unrecordedFrameOrigins].sort(),
    };

    const draft = assembleDraft({
      recordingId: this.recordingId!,
      workflowNameHint: this.workflowNameHint!,
      startedAt: this.startedAt!,
      stoppedAt,
      stopReason,
      actions: this.actions,
      metadata,
    });

    return this.store.saveDraft(this.recordingId!, draft);
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /**
   * Closes the recording browser and accounts for its process.
   *
   * Both the graceful and the forced path go through the shared supervisor, so
   * the managed reservation is released only after verified process-tree exit —
   * `force` shortens the polite window rather than skipping the accounting.
   */
  private async closeBrowser(opts: { force: boolean }): Promise<void> {
    const launched = this.launched;
    if (!launched) return;
    this.launched = null;
    this.reservation = null;
    try {
      // Force skips the polite close and terminates immediately; the shared
      // shutdown then observes the already-verified exit and releases the
      // managed reservation. Both paths account for the process.
      if (opts.force) await launched.supervisor.shutdown();
      await launched.shutdown();
    } catch {
      // A browser that cannot be proved gone is reported through the session's
      // abort path; teardown itself never throws over it.
    }
  }

  private emit(event: RecordingSessionEvent): void {
    this.eventEmitter.emit('event', event);
  }
}

// ---------------------------------------------------------------------------
// CDP event param shapes (internal)
// ---------------------------------------------------------------------------

interface FrameNavigatedParams {
  frame: {
    id: string;
    parentId?: string;
    url: string;
  };
}

interface FrameAttachedParams {
  frameId: string;
  parentFrameId?: string;
}

interface ExecutionContextCreatedParams {
  context: {
    id: number;
    auxData?: { isDefault?: boolean };
  };
}
