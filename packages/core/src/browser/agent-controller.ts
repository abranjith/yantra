import type { ElementHandle, HTTPRequest, Page as PuppeteerPage, Target } from 'puppeteer-core';

import { buildAgentPageSnapshot } from '../discovery/observe.js';
import { ReadabilityExtractor, type Extractor } from '../extraction/index.js';

import type { BrowserProvider, BrowserSession, Logger, Page } from './types.js';

const INTERACTABLE_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [role="link"], ' +
  '[role="checkbox"], [role="radio"], [role="combobox"], [role="tab"], [role="menuitem"]';

const DEFAULT_DIGEST_BYTES = 16 * 1024;
const DEFAULT_INTERACTABLE_CAP = 30;
const POPUP_CAPTURE_WAIT_MS = 5_000;
const POPUP_URL_WAIT_MS = 3_000;
/** Time to wait for a navigation that has already started (request fired) to
 * commit (server responds, frame swaps). This is response-header latency, not
 * full page load — content settling after commit is bounded separately below. */
const NAVIGATION_COMMIT_WAIT_MS = 20_000;
/** Hard cap on `page.goto()` itself, overriding Puppeteer's 30s default: real
 * sites (e.g. carrier tracking pages) can take up to ~60s to reach
 * `domcontentloaded` under load. */
const NAVIGATE_TIMEOUT_MS = 60_000;
const TITLE_READ_ATTEMPTS = 5;

/** Pause between mousedown and mouseup: real sites are written against a held
 * press, and some handlers (and bot heuristics) mis-fire on a 0ms one. */
const CLICK_HOLD_MS = 40;
/** How long after a click to keep watching for a navigation the site starts
 * late — async handlers, setTimeout redirects, validation-then-submit. */
const CLICK_NAV_DETECT_MS = 800;
/** Fills navigate far more rarely (search-as-you-type, auto-submit), so their
 * watch window is shorter. */
const FILL_NAV_DETECT_MS = 250;
/** Follow-up client-side redirects re-trigger quickly on the new document. */
const REDIRECT_CHAIN_DETECT_MS = 300;
/**
 * Hard cap on one action's whole stabilization (redirect chains included).
 * Sized to ~60s so a click/fill that triggers a slow-loading result page (a
 * carrier tracking page can take 10-30s to populate) is not reported back to
 * the agent before the content actually exists.
 */
const POST_ACTION_TOTAL_WAIT_MS = 60_000;
/**
 * Hard cap on settling a READ (observe/extract). Reads are the agent's only
 * view of the page, so one taken while a document is still loading shows a
 * blank or half-built DOM — the agent concludes the field it needs is missing
 * and retries or gives up. Matches the post-action cap: a page that is still
 * populating when the agent happens to read it (rather than immediately after
 * the action that started the load) deserves the same ~60s of patience.
 */
const READ_SETTLE_TOTAL_MS = 60_000;
const STABILITY_POLL_MS = 25;
const DOM_READY_POLL_MS = 100;
/**
 * Network-quiet window and cap. Strict idle (0 in-flight): a single fetch
 * carrying the action's outcome must be waited for. Pages that hold a
 * connection open (SSE, long-poll) degrade at the cap, never error.
 *
 * The cap is sized to ~60s, not a few seconds: it is always clamped to
 * whatever remains of the caller's overall deadline (`Math.min` at each call
 * site), so it never lengthens a fast page — but a slow one (a tracking page
 * whose result loads via one long-running fetch) needs this window to be as
 * large as the overall budget, not a small fraction of it.
 */
const NETWORK_QUIET_IDLE_MS = 300;
const NETWORK_QUIET_TIMEOUT_MS = 60_000;
const NETWORK_QUIET_MAX_INFLIGHT = 0;
/** Human-scale per-key delay so debounced validators keep up; dropped for
 * long values so a large fill cannot blow the tool budget. */
const FILL_TYPE_DELAY_MS = 20;
const FILL_TYPE_DELAY_MAX_CHARS = 128;

/**
 * Puppeteer failures caused by the document changing underneath an in-flight
 * call (navigation committing, a node being detached, or a handle disposed by
 * the navigation listener). These are races with the page, not tool bugs, and
 * are resolved by re-checking what the page actually did.
 */
const NAVIGATION_RACE_MESSAGE_RE =
  /execution context was destroyed|cannot find context with specified id|node is detached|detached frame|frame got detached|jshandle is disposed/i;

/** True for Puppeteer errors caused by the document changing mid-call. */
export function isNavigationRaceError(error: unknown): error is Error {
  return error instanceof Error && NAVIGATION_RACE_MESSAGE_RE.test(error.message);
}

/**
 * Puppeteer failures raised when Chrome could not produce a box for the node
 * at action time — it has no content quads or no layout. After the pre-flight
 * in `assertActionable` this only happens when the element went away between
 * the check and the action, so it means the same thing as a failed pre-flight.
 */
const NO_LAYOUT_BOX_MESSAGE_RE = /not clickable or not an|not visible or not an/i;

/** True for Puppeteer errors meaning the node had no layout box to act on. */
export function isNoLayoutBoxError(error: unknown): error is Error {
  return error instanceof Error && NO_LAYOUT_BOX_MESSAGE_RE.test(error.message);
}

export interface AgentInteractable {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
}

export interface AgentBrowserObservation {
  readonly url: string;
  readonly title: string;
  readonly digest: string;
  readonly interactables: readonly AgentInteractable[];
}

export interface BrowserActionResult {
  readonly url: string;
  readonly title: string;
  readonly popup_intercepted?: string;
  readonly dialog_intercepted?: string;
}

interface InteractableRecord extends AgentInteractable {
  readonly handle: ElementHandle<Element>;
}

/** Live view of whether an action set a main-frame navigation in motion. */
interface NavigationWatch {
  /** A main-frame navigation request is in flight or a commit has landed. */
  sawNavigation(): boolean;
  /** A main-frame navigation request is in flight and not yet aborted. */
  navigationPending(): boolean;
  /** The navigation epoch the watch is currently baselined against. */
  epoch(): number;
  /** Forget the handled navigation and re-baseline on the current document. */
  rebase(): void;
  /** Remove the page listeners. Must be called exactly once, in a finally. */
  dispose(): void;
}

/** Expected stale-ref failure that directs the agent back to observation. */
export class StaleElementRefError extends Error {
  public readonly code = 'STALE_ELEMENT_REF' as const;
  public constructor(ref: string) {
    super(`Element ref "${ref}" is stale or unknown. Call browser_observe again before acting.`);
    this.name = 'StaleElementRefError';
  }
}

/** Expected hidden/disabled/unmatched-option actionability failure. */
export class BrowserActionabilityError extends Error {
  public constructor(
    public readonly code: 'ELEMENT_HIDDEN' | 'ELEMENT_DISABLED' | 'OPTION_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserActionabilityError';
  }
}

function hiddenError(): BrowserActionabilityError {
  return new BrowserActionabilityError(
    'ELEMENT_HIDDEN',
    'The observed element is no longer visible. Re-observe the page.',
  );
}

export interface AgentBrowserControllerOptions {
  readonly runId: string;
  readonly browserProvider: BrowserProvider;
  readonly extractor?: Extractor;
  readonly logger?: Logger;
  readonly headless?: boolean;
  readonly maxDigestBytes?: number;
  readonly maxInteractables?: number;
}

/**
 * Owns the single ephemeral browser page for an agentic run. Launch is lazy,
 * popups are closed and surfaced, and JS dialogs are auto-handled and
 * surfaced so they can never deadlock the page.
 *
 * Every action holds its result until the page stops moving (see
 * `awaitPageStable`): navigations the site starts late, redirect chains, and
 * in-flight fetch/XHR updates are settled — all bounded — before the result
 * is reported, so the agent's next tool call never races the page.
 *
 * Ref lifecycle: an opaque ref stays valid from the observation that minted
 * it until the main frame navigates to a new document; successful actions do
 * NOT invalidate sibling refs. Re-observing the same document reuses the same
 * ref id for the same logical element (matched by role + name + duplicate
 * ordinal) while refreshing the underlying handle, so retries see consistent
 * ids. Genuine staleness (the specific node left the DOM) is detected at
 * action time. Ref numbering is monotonic across the run, and identity reuse
 * resets on navigation, so an id from a previous document can never silently
 * alias an element on a new one.
 */
export class AgentBrowserController {
  public readonly runId: string;

  private readonly provider: BrowserProvider;
  private readonly extractor: Extractor;
  private readonly logger: Logger | undefined;
  private readonly headless: boolean;
  private readonly maxDigestBytes: number;
  private readonly maxInteractables: number;
  private session: BrowserSession | null = null;
  private pageFacade: Page | null = null;
  private page: PuppeteerPage | null = null;
  private nextRef = 1;
  private refs = new Map<string, InteractableRecord>();
  private refIdByIdentity = new Map<string, string>();
  private navigationEpoch = 0;
  private popupUrls: string[] = [];
  private dialogMessages: string[] = [];
  private readonly popupCaptureTasks = new Set<Promise<void>>();
  private readonly popupCaptureByTarget = new WeakMap<Target, Promise<void>>();
  private teardownPromise: Promise<void> | null = null;

  public constructor(options: AgentBrowserControllerOptions) {
    this.runId = options.runId;
    this.provider = options.browserProvider;
    this.extractor = options.extractor ?? new ReadabilityExtractor();
    this.logger = options.logger;
    this.headless = options.headless ?? true;
    this.maxDigestBytes = options.maxDigestBytes ?? DEFAULT_DIGEST_BYTES;
    this.maxInteractables = options.maxInteractables ?? DEFAULT_INTERACTABLE_CAP;
  }

  /** True after the first navigation lazily launches Chrome. */
  public get launched(): boolean {
    return this.session !== null;
  }

  /** Ephemeral profile path while launched, otherwise undefined. */
  public get profileDir(): string | undefined {
    return this.session?.profilePath;
  }

  /**
   * Navigate the run page. The committed navigation (not this call) is what
   * invalidates prior refs, so a failed navigation leaves them usable.
   */
  public async navigate(url: string): Promise<BrowserActionResult> {
    await this.ensureLaunched();
    await this.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS });
    // Real pages often bounce once more right after DOMContentLoaded (JS or
    // meta-refresh redirects, client-side routers). Settle those before the
    // agent observes, so refs are minted on the document that will stay.
    const watch = this.watchNavigation();
    try {
      await this.awaitPageStable(watch, REDIRECT_CHAIN_DETECT_MS);
    } finally {
      watch.dispose();
    }
    return this.currentActionResult();
  }

  /**
   * Observe sanitized page text and mint/refresh opaque interactable refs.
   * Elements already seen on this document keep their ref id; only their
   * handle is refreshed.
   */
  public async observe(): Promise<AgentBrowserObservation> {
    this.assertLaunched();
    await this.awaitReadable();
    const snapshot = await buildAgentPageSnapshot(
      this.pageFacade!,
      { extractor: this.extractor },
      {
        maxDigestBytes: this.maxDigestBytes,
        maxInteractables: this.maxInteractables,
      },
    );
    const handles = await this.page!.$$(INTERACTABLE_SELECTOR);
    const superseded = this.refs;
    this.refs = new Map();
    const interactables: AgentInteractable[] = [];
    // Identity is role + name + ordinal among same-role/name elements in
    // observation order. It is a heuristic: if same-named elements are
    // inserted or reordered between observations, their ids can trade
    // places, but each id always resolves to a currently observed element.
    const ordinals = new Map<string, number>();
    const claimed = new Set<ElementHandle<Element>>();
    for (const raw of snapshot.interactables) {
      const handle = handles[raw.selectorIndex ?? -1];
      if (!handle || claimed.has(handle)) continue;
      const role = raw.role;
      const name = raw.name ?? '';
      const ordinalKey = `${role} ${name}`;
      const ordinal = ordinals.get(ordinalKey) ?? 0;
      ordinals.set(ordinalKey, ordinal + 1);
      const identity = `${ordinalKey} ${ordinal}`;
      let ref = this.refIdByIdentity.get(identity);
      if (!ref) {
        ref = `e${this.nextRef++}`;
        this.refIdByIdentity.set(identity, ref);
      }
      claimed.add(handle);
      this.refs.set(ref, { ref, role, name, handle });
      interactables.push({ ref, role, name });
    }
    for (const record of superseded.values()) disposeHandle(record.handle);
    for (const handle of handles) {
      if (!claimed.has(handle)) disposeHandle(handle);
    }
    return { ...snapshot, interactables };
  }

  /** Resolve a live opaque ref minted on the current document. */
  public resolveRef(ref: string): ElementHandle<Element> {
    const record = this.refs.get(ref);
    if (!record) throw new StaleElementRefError(ref);
    return record.handle;
  }

  /** Return model-safe ref metadata for policy classification. */
  public describeRef(ref: string): AgentInteractable | undefined {
    const record = this.refs.get(ref);
    return record ? { ref: record.ref, role: record.role, name: record.name } : undefined;
  }

  /** Click a current ref after deterministic visibility/hit-target checks. */
  public async click(ref: string): Promise<BrowserActionResult> {
    const handle = this.resolveRef(ref);
    await assertActionable(handle, ref);
    const page = this.page!;
    const declaresPopup = await evaluateOnRef(handle, ref, (element) => {
      const target = element.getAttribute('target')?.toLowerCase();
      const inlineHandler = element.getAttribute('onclick')?.toLowerCase() ?? '';
      return target === '_blank' || inlineHandler.includes('window.open');
    });
    // Register before dispatching the click so a popup event cannot land in
    // the gap between click completion and result assembly under suite load.
    // Only declared popup actions pay the bounded wait; ordinary clicks keep
    // their existing latency while the background listener covers dynamic
    // event-handler popups best-effort.
    const popupTarget = declaresPopup
      ? page
          .browser()
          .waitForTarget((target) => target.opener() === page.target(), {
            timeout: POPUP_CAPTURE_WAIT_MS,
          })
          .catch(() => null)
      : Promise.resolve(null);
    const watch = this.watchNavigation();
    try {
      try {
        // A held press (down, pause, up) is what real sites are written
        // against; Puppeteer scrolls into view and issues trusted CDP mouse
        // events, so this is a user-shaped click end to end.
        await handle.click({ delay: CLICK_HOLD_MS });
      } catch (error) {
        // The element lost its layout box between the pre-flight and the click.
        if (isNoLayoutBoxError(error)) throw hiddenError();
        // A click that submits or navigates can destroy the execution context
        // while the CDP call is in flight. Treat the click as landed ONLY once
        // the navigation actually commits (a framenavigated epoch bump) — a
        // mere in-flight request can still abort, and an unrelated request must
        // not be mistaken for the click's outcome. If no commit lands, the node
        // itself vanished and the ref is genuinely stale.
        if (!isNavigationRaceError(error)) throw error;
        await settle();
        if (!(await this.awaitCommit(watch))) throw new StaleElementRefError(ref);
      }
      // Hold the result until the page stops moving: navigations the site
      // starts hundreds of ms after the click, redirect chains, and in-flight
      // fetch/XHR updates are all settled (bounded) before the agent's next
      // tool call can race them.
      await this.awaitPageStable(watch, CLICK_NAV_DETECT_MS);
    } finally {
      watch.dispose();
    }
    const target = await popupTarget;
    if (target) await this.capturePopupTarget(target);
    return this.currentActionResult();
  }

  /** Fill a current ref without returning or logging the supplied value. */
  public async fill(ref: string, value: string): Promise<BrowserActionResult> {
    const handle = this.resolveRef(ref);
    await assertActionable(handle, ref);
    const watch = this.watchNavigation();
    try {
      if (!(await this.fillSelect(handle, ref, value))) {
        try {
          await handle.focus();
          // Select-all via triple-click, then overtype: replaces any existing
          // value with real key events, which framework listeners require.
          await handle.click({ clickCount: 3 });
          await handle.type(value, { delay: typeDelayFor(value) });
        } catch (error) {
          if (isNoLayoutBoxError(error)) throw hiddenError();
          if (isNavigationRaceError(error)) throw new StaleElementRefError(ref);
          throw error;
        }
      }
      // Fills can navigate too (search-as-you-type, auto-submitting forms);
      // settle before the agent's next call the same way clicks do.
      await this.awaitPageStable(watch, FILL_NAV_DETECT_MS);
    } finally {
      watch.dispose();
    }
    return this.currentActionResult();
  }

  /**
   * Native `<select>` elements do not accept typed text; choose the option
   * whose value or visible label matches instead, with the input/change
   * events a framework expects. Returns false when the ref is not a select.
   */
  private async fillSelect(
    handle: ElementHandle<Element>,
    ref: string,
    value: string,
  ): Promise<boolean> {
    const outcome = await evaluateOnRef(
      handle,
      ref,
      (element, wanted) => {
        if (!(element instanceof HTMLSelectElement)) return 'not_select';
        const options = Array.from(element.options);
        const match =
          options.find((option) => option.value === wanted) ??
          options.find((option) => (option.label || option.text).trim() === wanted.trim());
        if (!match) return 'no_match';
        element.value = match.value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return 'selected';
      },
      value,
    );
    if (outcome === 'no_match')
      throw new BrowserActionabilityError(
        'OPTION_NOT_FOUND',
        'No option in the observed dropdown matches the supplied value. Use an option label or value exactly as observed.',
      );
    return outcome === 'selected';
  }

  /** Extract readable page content or the first table as typed rows. */
  public async extract(kind: 'content' | 'table'): Promise<unknown> {
    this.assertLaunched();
    await this.awaitReadable();
    if (kind === 'content') {
      return this.page!.evaluate(() => ({
        title: document.title,
        text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      }));
    }
    return this.page!.evaluate(() => {
      const table = document.querySelector('table');
      if (!table) return { headers: [], rows: [] };
      const rows = Array.from(table.querySelectorAll('tr')).map((row) =>
        Array.from(row.querySelectorAll('th,td')).map((cell) =>
          (cell.textContent ?? '').replace(/\s+/g, ' ').trim(),
        ),
      );
      const first = rows[0] ?? [];
      const hasHeaders = table.querySelector('thead, tr th') !== null;
      return { headers: hasHeaders ? first : [], rows: hasHeaders ? rows.slice(1) : rows };
    });
  }

  /** Live page hostname for policy/secret binding. */
  public host(): string {
    try {
      return new URL(this.page?.url() ?? '').hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  /** Close Chrome and remove the ephemeral profile. Idempotent. */
  public teardown(): Promise<void> {
    this.teardownPromise ??= this.performTeardown();
    return this.teardownPromise;
  }

  private async ensureLaunched(): Promise<void> {
    if (this.session) return;
    const session = await this.provider.launch({
      profile: { kind: 'ephemeral' },
      headless: this.headless,
    });
    const facade = await session.newPage();
    if (!facade.puppeteerPage) {
      await session.close();
      throw new Error('Browser provider did not expose a Puppeteer page for agent tools.');
    }
    this.session = session;
    this.pageFacade = facade;
    this.page = facade.puppeteerPage;
    this.installPagePolicies(this.page);
  }

  private installPagePolicies(page: PuppeteerPage): void {
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      // A committed main-frame navigation is the one moment refs are truly
      // dead: the old document is gone. Identity-based id reuse resets with
      // them so an id from the previous document can never alias an element
      // on the new one.
      this.navigationEpoch += 1;
      this.invalidateObservation();
      this.refIdByIdentity.clear();
    });
    page.browser().on('targetcreated', (target) => {
      if (target.opener() !== page.target()) return;
      // Intercepting a popup does not change the main document, so the main
      // page's refs stay valid.
      void this.capturePopupTarget(target);
    });
    page.on('dialog', (dialog) => {
      // A JS dialog freezes every evaluate on the page until it is handled —
      // left alone it deadlocks the run. Accept beforeunload so an agent-
      // initiated navigation proceeds; dismiss the rest (auto-accepting a
      // confirm() would silently authorize an action nobody reviewed) and
      // surface the message on the next action result.
      this.dialogMessages.push(`${dialog.type()}: ${dialog.message()}`.trim());
      const resolution = dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss();
      void resolution.catch(() => undefined);
    });
  }

  private capturePopupTarget(target: Target): Promise<void> {
    const existing = this.popupCaptureByTarget.get(target);
    if (existing) return existing;
    const task = (async () => {
      const popup = await target.page();
      if (!popup) return;
      // window.open popups start life at about:blank and navigate
      // asynchronously; wait (bounded) for the real URL so the agent can
      // re-enter it through navigation policy instead of losing it.
      const deadline = Date.now() + POPUP_URL_WAIT_MS;
      let url = popup.url() || target.url();
      while ((url === '' || url === 'about:blank') && Date.now() < deadline) {
        await sleep(STABILITY_POLL_MS);
        if (popup.isClosed()) break;
        url = popup.url() || target.url();
      }
      if (url && url !== 'about:blank') this.popupUrls.push(url);
      await popup.close().catch(() => undefined);
    })();
    this.popupCaptureByTarget.set(target, task);
    this.popupCaptureTasks.add(task);
    void task.finally(() => this.popupCaptureTasks.delete(task));
    return task;
  }

  private invalidateObservation(): void {
    for (const record of this.refs.values()) disposeHandle(record.handle);
    this.refs.clear();
  }

  private async currentActionResult(): Promise<BrowserActionResult> {
    await settle();
    await Promise.allSettled([...this.popupCaptureTasks]);
    const popup = this.popupUrls.shift();
    const dialog = this.dialogMessages.shift();
    const title = await this.currentTitle();
    let result: BrowserActionResult = { url: this.page?.url() ?? '', title };
    if (popup) result = { ...result, popup_intercepted: popup };
    if (dialog) result = { ...result, dialog_intercepted: dialog };
    return result;
  }

  /**
   * Start watching for a main-frame navigation caused by an action. Installed
   * BEFORE the action is dispatched so a synchronously started navigation
   * cannot slip between the action and the watch.
   */
  private watchNavigation(): NavigationWatch {
    const page = this.page!;
    let baseline = this.navigationEpoch;
    let pending: HTTPRequest | null = null;
    const onRequest = (request: HTTPRequest): void => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) pending = request;
    };
    const onRequestFailed = (request: HTTPRequest): void => {
      // An aborted main-frame navigation request (download, superseded
      // redirect) will never commit; forgetting it keeps the wait short.
      if (request === pending) pending = null;
    };
    page.on('request', onRequest);
    page.on('requestfailed', onRequestFailed);
    return {
      sawNavigation: () => pending !== null || this.navigationEpoch !== baseline,
      navigationPending: () => pending !== null,
      epoch: () => baseline,
      rebase: () => {
        pending = null;
        baseline = this.navigationEpoch;
      },
      dispose: () => {
        page.off('request', onRequest);
        page.off('requestfailed', onRequestFailed);
      },
    };
  }

  /**
   * Hold an action's result until the page has stopped moving:
   *
   * 1. Grace window — watch for a main-frame navigation triggered by the
   *    action, however the site schedules it (sync handler, microtask,
   *    setTimeout, async validation then submit). This catches the real-world
   *    "the click navigated 200ms later" case that a fixed post-action pause
   *    misses.
   * 2. When a navigation starts, wait (bounded) for the new document to
   *    commit and reach DOMContentLoaded, then re-arm a shorter grace window
   *    so chained client-side redirects are followed too.
   * 3. Finish with a bounded network-quiet wait so fetch/XHR-driven updates
   *    (SPA actions that never navigate) have landed before the agent's next
   *    observation.
   *
   * Every phase is bounded; a page that never settles degrades to a result
   * after the caps rather than an error.
   */
  private async awaitPageStable(watch: NavigationWatch, graceMs: number): Promise<void> {
    const overallDeadline = Date.now() + POST_ACTION_TOTAL_WAIT_MS;
    let grace = graceMs;
    for (;;) {
      const graceDeadline = Math.min(Date.now() + grace, overallDeadline);
      while (!watch.sawNavigation() && Date.now() < graceDeadline) {
        await sleep(STABILITY_POLL_MS);
      }
      if (!watch.sawNavigation()) break;
      // Wait for the commit (framenavigated bumps the epoch). A pending
      // request that aborts instead of committing releases the wait early.
      const commitDeadline = Math.min(Date.now() + NAVIGATION_COMMIT_WAIT_MS, overallDeadline);
      while (
        this.navigationEpoch === watch.epoch() &&
        watch.navigationPending() &&
        Date.now() < commitDeadline
      ) {
        await sleep(STABILITY_POLL_MS);
      }
      if (this.navigationEpoch !== watch.epoch()) {
        await this.awaitDomReady(Math.min(NAVIGATION_COMMIT_WAIT_MS, overallDeadline - Date.now()));
      }
      watch.rebase();
      grace = REDIRECT_CHAIN_DETECT_MS;
      if (Date.now() >= overallDeadline) break;
    }
    await this.awaitNetworkQuiet(overallDeadline);
  }

  /**
   * Resolve whether a click that threw a context-destroyed error actually
   * landed. That error only arises while a new document is committing, so wait
   * (bounded) for the commit to register as a navigation-epoch bump. Waiting
   * continues only while a main-frame request is still in flight; once it
   * aborts — or if there was never one (a coincidental node detach) — no commit
   * is coming, so the click did not land and the ref is stale. Requiring the
   * commit, not a mere in-flight request, keeps an unrelated navigation from
   * being mistaken for the click's outcome.
   */
  private async awaitCommit(watch: NavigationWatch): Promise<boolean> {
    const deadline = Date.now() + NAVIGATION_COMMIT_WAIT_MS;
    while (this.navigationEpoch === watch.epoch()) {
      if (!watch.navigationPending() || Date.now() >= deadline) break;
      await sleep(STABILITY_POLL_MS);
    }
    return this.navigationEpoch !== watch.epoch();
  }

  /**
   * Hold a READ (observe/extract) until the page is done loading.
   *
   * Actions settle themselves before returning, but a read is not preceded by
   * an action: the agent may call `browser_observe` while a load started
   * elsewhere is still in flight — a slow first paint, a redirect chain the
   * action's own window did not outlast, or an SPA route still fetching. The
   * snapshot then shows a document that no longer exists a moment later, and
   * the agent acts on refs for elements that were never really there.
   *
   * Waiting on `document.readyState` rather than a navigation watch is what
   * makes this work for a load already in flight: a freshly installed watch
   * only hears requests that start after it, whereas `readyState` reports the
   * document's actual state right now. The network-quiet tail then lets
   * fetch/XHR-driven content land. Both phases are bounded, so a page that
   * never settles degrades to a read rather than an error.
   */
  private async awaitReadable(): Promise<void> {
    const deadline = Date.now() + READ_SETTLE_TOTAL_MS;
    await this.awaitDomReady(READ_SETTLE_TOTAL_MS);
    await this.awaitNetworkQuiet(deadline);
  }

  /** Wait (bounded) for the current document to leave `loading`. */
  private async awaitDomReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.page!.evaluate(() => document.readyState !== 'loading')) return;
      } catch (error) {
        // Another navigation tore down the context mid-check; the next lap
        // asks the new document.
        if (!isNavigationRaceError(error)) throw error;
      }
      await sleep(DOM_READY_POLL_MS);
    }
  }

  /**
   * Best-effort wait for in-flight fetch/XHR work to finish so the DOM the
   * agent observes next reflects the action's outcome.
   */
  private async awaitNetworkQuiet(overallDeadline: number): Promise<void> {
    const budget = Math.min(NETWORK_QUIET_TIMEOUT_MS, overallDeadline - Date.now());
    if (budget <= 0) return;
    await this.page!.waitForNetworkIdle({
      idleTime: NETWORK_QUIET_IDLE_MS,
      timeout: budget,
      concurrency: NETWORK_QUIET_MAX_INFLIGHT,
    }).catch(() => undefined);
  }

  /** Read the title, riding out mid-navigation context teardown. */
  private async currentTitle(): Promise<string> {
    for (let attempt = 0; attempt < TITLE_READ_ATTEMPTS; attempt += 1) {
      try {
        return await this.page!.title();
      } catch (error) {
        if (!isNavigationRaceError(error)) throw error;
        await settle();
      }
    }
    return '';
  }

  private assertLaunched(): void {
    if (!this.session || !this.pageFacade || !this.page)
      throw new Error('Call browser_navigate before using this browser tool.');
  }

  private async performTeardown(): Promise<void> {
    this.invalidateObservation();
    this.refIdByIdentity.clear();
    const session = this.session;
    this.session = null;
    this.page = null;
    this.pageFacade = null;
    if (session) await session.close();
    this.logger?.info({ runId: this.runId }, 'agent browser controller torn down');
  }
}

/**
 * Run `handle.evaluate(fn, ...args)`, translating document-changed races into
 * the typed stale-ref failure for the given ref.
 */
async function evaluateOnRef<T, A extends unknown[]>(
  handle: ElementHandle<Element>,
  ref: string,
  fn: (element: Element, ...args: A) => T,
  ...args: A
): Promise<T> {
  // Puppeteer's evaluate generics resist a variadic wrapper; the runtime
  // contract (serialize fn + args, run against the element) is unchanged.
  const evaluate = handle.evaluate.bind(handle) as (
    fn: (element: Element, ...args: A) => T,
    ...args: A
  ) => Promise<T>;
  try {
    return await evaluate(fn, ...args);
  } catch (error) {
    if (isNavigationRaceError(error)) throw new StaleElementRefError(ref);
    throw error;
  }
}

/**
 * Pre-flight only the facts that do not depend on where the viewport happens
 * to be scrolled: the node is still in the document, has a laid-out box, is
 * not `display:none`/`visibility:hidden`, and is not disabled.
 *
 * Occlusion is deliberately NOT checked. A script-side `elementFromPoint`
 * probe takes viewport coordinates, so it reported every below-the-fold
 * element as intercepted even though Puppeteer scrolls the element into view
 * as the first step of the action, and it could not see through shadow roots
 * or off-centre hit targets. There is no cheap deterministic replacement:
 * Chrome resolves a click point from content quads without hit-testing, so a
 * genuinely covered element is clicked through to whatever covers it — the
 * same thing a real user's click does. The agent detects that outcome by
 * re-observing, which it must do after any action anyway.
 */
async function assertActionable(handle: ElementHandle<Element>, ref: string): Promise<void> {
  const state = await evaluateOnRef(handle, ref, (element) => {
    const html = element as HTMLElement;
    const rect = html.getBoundingClientRect();
    const style = getComputedStyle(html);
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden';
    const disabled =
      ('disabled' in html && Boolean((html as HTMLInputElement).disabled)) ||
      html.getAttribute('aria-disabled') === 'true';
    return { connected: html.isConnected, visible, disabled };
  });
  if (!state.connected) throw new StaleElementRefError(ref);
  if (!state.visible) throw hiddenError();
  if (state.disabled)
    throw new BrowserActionabilityError('ELEMENT_DISABLED', 'The observed element is disabled.');
}

/** Dispose a handle without letting a dead-context rejection escape. */
function disposeHandle(handle: ElementHandle<Element>): void {
  void Promise.resolve(handle.dispose()).catch(() => undefined);
}

/** Per-character key delay for a fill value; see FILL_TYPE_DELAY_MS. */
function typeDelayFor(value: string): number {
  return value.length <= FILL_TYPE_DELAY_MAX_CHARS ? FILL_TYPE_DELAY_MS : 0;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function settle(): Promise<void> {
  await sleep(30);
}
