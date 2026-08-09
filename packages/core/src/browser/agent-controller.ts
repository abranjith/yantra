import { createHash } from 'node:crypto';

import type { LocatorCandidate } from '@yantra/protocol';
import type { ElementHandle, KeyInput, Page as PuppeteerPage, Target } from 'puppeteer-core';

import type { RawInteractable } from '../discovery/interactable-scan.js';
import { buildAgentPageSnapshot } from '../discovery/observe.js';
import { ReadabilityExtractor, type Extractor } from '../extraction/index.js';
import { intentsToWorkflowCandidates } from '../locator/candidate-codec.js';
import type { ElementDescription } from '../locator/types.js';
import type { WidgetPort } from '../widgets/types.js';

import {
  CLICK_NAV_DETECT_MS,
  FILL_NAV_DETECT_MS,
  isNavigationRaceError,
  PageSettler,
  REDIRECT_CHAIN_DETECT_MS,
  type NavigationWatch,
} from './page-settle.js';
import type { BrowserProvider, BrowserSession, Logger, Page } from './types.js';

// Note: page settling (navigation watching, redirect chains, network quiet)
// and its error classifiers moved to `page-settle.ts` so that deterministic
// workflow replay waits exactly the way the agent does. They are deliberately
// NOT re-exported here — two `export *` barrels exposing the same name make it
// ambiguous, and ESM then silently omits it from the package entry point.

/**
 * Handle-resolution selector. **Must stay byte-identical in membership and
 * order to the one in `discovery/interactable-scan.ts`**: the scanner reports a
 * `selectorIndex` into its own candidate list, and `observe()` indexes this
 * `page.$$()` result with it. A selector that drifts from the scanner's does not
 * fail loudly — it silently binds every ref to the wrong element.
 */
const INTERACTABLE_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [role="link"], ' +
  '[role="checkbox"], [role="radio"], [role="combobox"], [role="tab"], [role="menuitem"], ' +
  '[role="option"], [data-yantra-widget-target]';

const DEFAULT_DIGEST_BYTES = 16 * 1024;
const DEFAULT_INTERACTABLE_CAP = 50;
/**
 * Ceiling on interactables resolved for an internal (uncapped) observation.
 * Bounds the handle set on pathological pages; never model-visible.
 */
const MAX_RESOLUTION_INTERACTABLES = 400;
const POPUP_CAPTURE_WAIT_MS = 5_000;
const POPUP_URL_WAIT_MS = 3_000;
/** Hard cap on `page.goto()` itself, overriding Puppeteer's 30s default: real
 * sites (e.g. carrier tracking pages) can take up to ~60s to reach
 * `domcontentloaded` under load. */
const NAVIGATE_TIMEOUT_MS = 60_000;
const TITLE_READ_ATTEMPTS = 5;

/** Pause between mousedown and mouseup: real sites are written against a held
 * press, and some handlers (and bot heuristics) mis-fire on a 0ms one. */
const CLICK_HOLD_MS = 40;
/** Brief hover dwell before a pointer action, allowing real hover states and
 * menus to react before the trusted click/focus events arrive. */
const POINTER_SETTLE_MS = 75;
const STABILITY_POLL_MS = 25;

/** Human-scale per-key delay so debounced validators keep up; dropped for
 * long values so a large fill cannot blow the tool budget. */
const FILL_TYPE_DELAY_MS = 45;
const FILL_TYPE_DELAY_MAX_CHARS = 128;

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
  /** Nearest labelled widget/container, omitted when no context is available. */
  readonly group?: string;
  /** Omitted for enabled elements. */
  readonly disabled?: true;
  /** Current non-secret field/selection value, omitted when empty. */
  readonly value?: string;
  /** True when a sensitive field has a value that was withheld in-page. */
  readonly value_present?: true;
  readonly checked?: boolean;
  readonly expanded?: boolean;
  readonly selected?: boolean;
}

export interface AgentBrowserObservation {
  readonly url: string;
  readonly title: string;
  readonly digest: string;
  readonly digestUnchanged: boolean;
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

interface ElementIdentity {
  readonly role: string;
  readonly name: string;
  readonly group: string | null;
}

/** Expected stale-ref failure that directs the agent back to observation. */
export class StaleElementRefError extends Error {
  public readonly code = 'STALE_ELEMENT_REF' as const;
  public constructor(ref: string, reason?: string) {
    super(
      reason
        ? `Element ref "${ref}" is stale: ${reason}.`
        : `Element ref "${ref}" is stale or unknown. Use the fresh observation returned by the ` +
            'latest action, or call browser_observe for a new read before acting.',
    );
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
export class AgentBrowserController implements WidgetPort {
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
  private identityByRef = new Map<string, ElementIdentity>();
  private settler: PageSettler | null = null;
  private popupUrls: string[] = [];
  private dialogMessages: string[] = [];
  private readonly popupCaptureTasks = new Set<Promise<void>>();
  private readonly popupCaptureByTarget = new WeakMap<Target, Promise<void>>();
  private teardownPromise: Promise<void> | null = null;
  private lastDigestHash: string | null = null;

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
   *
   * @param options.cap - Maximum interactables to resolve, defaulting to the
   *   controller's 50-element model-visible cap and clamped to
   *   {@link MAX_RESOLUTION_INTERACTABLES} so a huge page cannot explode the
   *   handle set. **This is for internal resolution only** — a tool that needs
   *   to address an element the model never saw (`browser_form_fill` matching a
   *   field name, or an autocomplete option) raises it for its own lookup. It
   *   must never be used to widen what is returned to the model: `browser_observe`
   *   calls `observe()` with no argument precisely so the model-visible surface
   *   stays bounded.
   * @param options.trackDigest - Whether this model-visible observation updates
   *   digest delta tracking. Internal uncapped resolution calls pass `false`,
   *   because they must not consume a digest the model has never received.
   */
  public async observe(
    options: { readonly cap?: number; readonly trackDigest?: boolean } = {},
  ): Promise<AgentBrowserObservation> {
    this.assertLaunched();
    await this.awaitReadable();
    const cap = Math.max(
      1,
      Math.min(Math.floor(options.cap ?? this.maxInteractables), MAX_RESOLUTION_INTERACTABLES),
    );
    const snapshot = await buildAgentPageSnapshot(
      this.pageFacade!,
      { extractor: this.extractor },
      {
        maxDigestBytes: this.maxDigestBytes,
        maxInteractables: cap,
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
      const projected = projectAgentInteractable(ref, raw);
      this.refs.set(ref, { ...projected, handle });
      this.identityByRef.set(ref, {
        role: projected.role,
        name: projected.name,
        group: projected.group ?? null,
      });
      interactables.push(projected);
    }
    for (const record of superseded.values()) disposeHandle(record.handle);
    for (const handle of handles) {
      if (!claimed.has(handle)) disposeHandle(handle);
    }
    const digestHash = createHash('sha256').update(snapshot.digest).digest('hex').slice(0, 16);
    const trackDigest = options.trackDigest ?? true;
    const digestUnchanged = trackDigest && digestHash === this.lastDigestHash;
    if (trackDigest && !digestUnchanged) this.lastDigestHash = digestHash;
    return {
      ...snapshot,
      digest: digestUnchanged ? '' : snapshot.digest,
      digestUnchanged,
      interactables,
    };
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
    if (!record) return undefined;
    const { handle: _handle, ...described } = record;
    return described;
  }

  /**
   * Derive the durable locator chain for a ref, ranked best-first, so a
   * promoted workflow can find this element again on a later run.
   *
   * The chain is computed by the locator engine's own ranker running against
   * the live element (`window.__yantra.describeElement`), which matters more
   * than it looks: replay resolves role and accessible name with that engine's
   * tables and precedence rules. A locator derived from any other computation —
   * the observation scanner's simplified role map, for instance, which reports
   * `<select>` as `combobox` where the engine computes `listbox`, and
   * `input[type=search]` as `textbox` where the engine computes `searchbox` —
   * pins a role that can never match at replay. Sharing the implementation
   * removes that whole class of failure by construction.
   *
   * Best-effort: if the injected runtime is unavailable (a provider that
   * exposes no locator host, a page mid-navigation) this returns an empty
   * chain and the caller falls back to the observed role/name.
   *
   * @param ref - A live opaque ref from the latest observation.
   * @returns Ranked persistable candidates, or `[]` when they cannot be derived.
   */
  public async locatorFor(ref: string): Promise<LocatorCandidate[]> {
    const host = this.pageFacade?.locatorHost;
    if (!host) return [];
    let handle: ElementHandle<Element>;
    try {
      handle = this.resolveRef(ref);
    } catch {
      return [];
    }
    try {
      await host.ensureInjected('main');
      const described = await handle.evaluate((element) => {
        // Serialized into the page, so the injected runtime is reached through
        // the global rather than an import.
        const api = (
          globalThis as unknown as {
            __yantra?: { describeElement(el: Element): unknown };
          }
        ).__yantra;
        return api ? api.describeElement(element) : null;
      });
      if (described === null) return [];
      const { candidates } = described as ElementDescription;
      return intentsToWorkflowCandidates(candidates);
    } catch (error) {
      // A locator is a nice-to-have for the trace, never a reason to fail the
      // action the agent is performing.
      this.logger?.debug?.(
        { ref, err: error instanceof Error ? error.message : String(error) },
        'locator derivation failed; falling back to observed role/name',
      );
      return [];
    }
  }

  /** Click a current ref after deterministic visibility/hit-target checks. */
  public async click(ref: string): Promise<BrowserActionResult> {
    return this.withIdentityHealing(ref, () => this.clickOnce(ref));
  }

  private async clickOnce(ref: string): Promise<BrowserActionResult> {
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
        // Hover first so the pointer scrolls into view and any hover state has
        // time to settle, then dispatch a held press (down, pause, up).
        await handle.hover();
        await sleep(POINTER_SETTLE_MS);
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
    return this.withIdentityHealing(ref, () => this.fillOnce(ref, value));
  }

  private async fillOnce(ref: string, value: string): Promise<BrowserActionResult> {
    const handle = this.resolveRef(ref);
    await assertActionable(handle, ref);
    const watch = this.watchNavigation();
    try {
      try {
        await handle.hover();
        await sleep(POINTER_SETTLE_MS);
        if (!(await this.fillSelect(handle, ref, value))) {
          await handle.focus();
          // Select-all via triple-click, then overtype: replaces any existing
          // value with real mouse/key events, which framework listeners require.
          await handle.click({ clickCount: 3, delay: CLICK_HOLD_MS });
          await handle.type(value, { delay: typeDelayFor(value) });
        }
      } catch (error) {
        if (isNoLayoutBoxError(error)) throw hiddenError();
        if (isNavigationRaceError(error)) throw new StaleElementRefError(ref);
        throw error;
      }
      // Fills can navigate too (search-as-you-type, auto-submitting forms);
      // settle before the agent's next call the same way clicks do.
      await this.awaitPageStable(watch, FILL_NAV_DETECT_MS);
    } finally {
      watch.dispose();
    }
    return this.currentActionResult();
  }

  /** Evaluate a serializable function in the live page document. */
  public async evaluate<T, Args extends readonly unknown[]>(
    fn: (...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<T> {
    this.assertLaunched();
    const evaluate = this.page!.evaluate.bind(this.page!) as unknown as (
      pageFunction: (...values: Args) => T | Promise<T>,
      ...values: Args
    ) => Promise<T>;
    return evaluate(fn, ...args);
  }

  /** Evaluate a serializable function against an observed live element. */
  public async evaluateOn<T, Args extends readonly unknown[]>(
    ref: string,
    fn: (element: HTMLElement, ...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<T> {
    return this.withIdentityHealing(ref, () => this.evaluateOnOnce(ref, fn, ...args));
  }

  private async evaluateOnOnce<T, Args extends readonly unknown[]>(
    ref: string,
    fn: (element: HTMLElement, ...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<T> {
    const handle = this.resolveRef(ref);
    return evaluateOnRef(
      handle,
      ref,
      fn as (element: Element, ...values: Args) => T | Promise<T>,
      ...args,
    );
  }

  /** Send a key to the active page (used to restore popup state with Escape). */
  public async press(key: string): Promise<void> {
    this.assertLaunched();
    await this.page!.keyboard.press(key as KeyInput);
  }

  /** Millisecond clock used by bounded widget polling. */
  public now(): number {
    return Date.now();
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

  /** Live page URL, or `''` before the first navigation. */
  public url(): string {
    return this.page?.url() ?? '';
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
    // The settler owns navigation-epoch and in-flight bookkeeping; the
    // controller only needs to know when a navigation commits, because that is
    // the one moment refs are truly dead — the old document is gone. Identity-
    // based id reuse resets with them so an id from the previous document can
    // never alias an element on the new one.
    this.settler = new PageSettler(page, {
      onNavigationCommitted: () => {
        this.invalidateObservation();
        this.refIdByIdentity.clear();
        this.identityByRef.clear();
        this.lastDigestHash = null;
      },
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

  private async withIdentityHealing<T>(ref: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof StaleElementRefError)) throw error;
      const identity = this.identityByRef.get(ref);
      if (!identity) throw error;
      const observation = await this.observe({
        cap: MAX_RESOLUTION_INTERACTABLES,
        trackDigest: false,
      });
      const matches = observation.interactables.filter(
        (entry) =>
          entry.role === identity.role &&
          entry.name === identity.name &&
          (entry.group ?? null) === identity.group,
      );
      if (matches.length === 0) {
        throw new StaleElementRefError(ref, 'element left the page');
      }
      if (matches.length > 1) {
        throw new StaleElementRefError(
          ref,
          `${matches.length} elements now share this identity (role="${identity.role}", name="${identity.name}")`,
        );
      }
      this.rebindRef(ref, matches[0]!.ref, identity);
      return operation();
    }
  }

  private rebindRef(ref: string, liveRef: string, identity: ElementIdentity): void {
    const live = this.refs.get(liveRef);
    if (!live) throw new StaleElementRefError(ref, 'element left the page');
    if (liveRef !== ref) {
      this.refs.delete(liveRef);
      this.identityByRef.delete(liveRef);
      for (const [key, mappedRef] of this.refIdByIdentity) {
        if (mappedRef === liveRef) this.refIdByIdentity.set(key, ref);
      }
    }
    this.refs.set(ref, { ...live, ref });
    this.identityByRef.set(ref, identity);
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
    return this.settler!.watch();
  }

  /** @see PageSettler.settleAfterAction */
  private awaitPageStable(watch: NavigationWatch, graceMs: number): Promise<void> {
    return this.settler!.settleAfterAction(watch, graceMs);
  }

  /** @see PageSettler.awaitCommit */
  private awaitCommit(watch: NavigationWatch): Promise<boolean> {
    return this.settler!.awaitCommit(watch);
  }

  /** @see PageSettler.settleBeforeRead */
  private awaitReadable(): Promise<void> {
    return this.settler!.settleBeforeRead();
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
    this.identityByRef.clear();
    this.lastDigestHash = null;
    this.settler?.dispose();
    this.settler = null;
    const session = this.session;
    this.session = null;
    this.page = null;
    this.pageFacade = null;
    if (session) await session.close();
    this.logger?.info({ runId: this.runId }, 'agent browser controller torn down');
  }
}

/** Internal raw-scan to model-visible projection; exported for shape contract tests. */
export function projectAgentInteractable(ref: string, raw: RawInteractable): AgentInteractable {
  const projected: {
    ref: string;
    role: string;
    name: string;
    group?: string;
    disabled?: true;
    value?: string;
    value_present?: true;
    checked?: boolean;
    expanded?: boolean;
    selected?: boolean;
  } = { ref, role: raw.role, name: raw.name ?? '' };
  if (raw.group) projected.group = raw.group;
  if (raw.disabled) projected.disabled = true;
  if (raw.value) projected.value = raw.value;
  if (raw.valuePresent) projected.value_present = true;
  if (raw.checked) projected.checked = true;
  if (raw.expanded !== null) projected.expanded = raw.expanded;
  if (raw.selected !== null) projected.selected = raw.selected;
  return projected;
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
    throw new BrowserActionabilityError(
      'ELEMENT_DISABLED',
      'The observed element is disabled. Disabled elements are marked disabled: true in the observation; choose a different element.',
    );
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
