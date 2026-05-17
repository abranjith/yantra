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
import type { Browser, CDPSession, Page as PuppeteerPage } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

import { detectChrome } from '../../browser/chrome-discovery.js';
import { cacheDir } from '../../browser/paths.js';

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
  const bundlePath = join(__dirname, '..', '..', '..', '..', 'dist', 'recorder-overlay.iife.js');
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
  /** Override the Chrome executable path. */
  chromeOverridePath?: string;
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
  private browser: Browser | null = null;
  private mainPage: PuppeteerPage | null = null;
  private mainPageCDP: CDPSession | null = null;
  private browserCDP: CDPSession | null = null;
  private mainTargetId: string | null = null;

  // Module instances
  private idleWatcher: IdleWatcher | null = null;
  private popupHandler: PopupHandler | null = null;

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
  private yantraVersion = '0.0.0';

  // Handle internals
  private eventEmitter = new EventEmitter();
  private doneResolve: ((val: { draftPath: string; stopReason: StopReason }) => void) | null = null;
  private doneReject: ((err: Error) => void) | null = null;
  private keepProfile = false;

  constructor(deps?: { store?: RecordingStore; redactor?: CaptureRedactor }) {
    this.store = deps?.store ?? new FileSystemRecordingStore(cacheDir());
    this.redactor = deps?.redactor ?? new DefaultCaptureRedactor();
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
        await readFile(join(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8'),
      ) as { version?: string };
      this.yantraVersion = pkgJson.version ?? '0.0.0';
    } catch {
      // Non-fatal
    }

    // Launch headful Chrome
    const chrome = detectChrome(
      opts.chromeOverridePath ? { override: opts.chromeOverridePath } : {},
    );
    if (!chrome) {
      throw new Error('Chrome not found. Run `yantra doctor` for diagnostics.');
    }

    this.chromeVersion = chrome.version;
    this.chromeMajor = chrome.majorVersion;

    const profileDir = join(recordingDir, 'profile');

    this.browser = await puppeteer.launch({
      executablePath: chrome.path,
      headless: false,
      pipe: true,
      userDataDir: profileDir,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=TranslateUI',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
      ],
      defaultViewport: null,
    });

    // Browser-level CDP for target lifecycle
    this.browserCDP = await this.browser.target().createCDPSession();

    // Open main page
    this.mainPage = await this.browser.newPage();
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
    await this.mainPageCDP.send('Runtime.addBinding', {
      name: '__yantraRecorderEmit',
    });

    // Read and inject overlay bundle
    const overlayCode = await readOverlayBundle();
    await this.mainPageCDP.send('Page.addScriptToEvaluateOnNewDocument', {
      source: overlayCode,
    });

    // Listen for binding calls (in-page → Node)
    this.mainPageCDP.on('Runtime.bindingCalled', (params: unknown) => {
      this.onBindingCalled(params as { name: string; payload: string });
    });

    // Navigation capture (TASK-005)
    this.mainPageCDP.on('Page.frameNavigated', (params: unknown) => {
      this.onFrameNavigated(params as FrameNavigatedParams);
    });

    // Frame attachment for cross-origin detection (TASK-006a)
    this.mainPageCDP.on('Page.frameAttached', (params: unknown) => {
      void this.onFrameAttached(params as FrameAttachedParams);
    });

    // Enable Page domain
    await this.mainPageCDP.send('Page.enable');

    // Crash detection (TASK-013)
    this.browser.on('disconnected', () => {
      if (this.state === 'recording' || this.state === 'paused') {
        void this.abort('browser_disconnected');
      }
    });

    // Setup popup handler (TASK-006)
    if (this.recordingId === null) {
      throw new Error('recordingId is unexpectedly null after session start');
    }
    this.popupHandler = new PopupHandler(this.browserCDP, this.mainTargetId, this.recordingId, {
      onEvent: (event) => this.emit(event),
      onPopupSession: (session, _targetId) => this.installOverlayOnSession(session),
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
      ts: this.startedAt,
    });

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
    await session.send('Runtime.addBinding', { name: '__yantraRecorderEmit' });

    const overlayCode = await readOverlayBundle();
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: overlayCode });
    await session.send('Page.enable');

    session.on('Runtime.bindingCalled', (params: unknown) => {
      this.onBindingCalled(params as { name: string; payload: string });
    });

    session.on('Page.frameNavigated', (params: unknown) => {
      this.onFrameNavigated(params as FrameNavigatedParams);
    });
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

  private async closeBrowser(opts: { force: boolean }): Promise<void> {
    if (!this.browser) return;
    try {
      if (opts.force) {
        const child = this.browser.process();
        if (child) {
          child.kill('SIGKILL');
          return;
        }
      }
      await Promise.race([
        this.browser.close(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('browser close timeout')), 5000),
        ),
      ]);
    } catch {
      const child = this.browser.process();
      child?.kill('SIGKILL');
    } finally {
      this.browser = null;
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
