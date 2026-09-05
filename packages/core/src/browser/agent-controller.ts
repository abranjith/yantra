import { createHash } from 'node:crypto';

import type { LocatorCandidate } from '@yantra/protocol';
import type { ElementHandle, KeyInput, Page as PuppeteerPage, Target } from 'puppeteer-core';

import { collectComposedInteractables } from '../discovery/composed-handles.js';
import type { RawInteractable } from '../discovery/interactable-scan.js';
import { buildAgentPageSnapshot, ensureLocatorRuntime } from '../discovery/observe.js';
import { ReadabilityExtractor, type Extractor } from '../extraction/index.js';
import { assertReceivable } from '../interaction/capabilities.js';
import { renderInteractionMessage } from '../interaction/messages.js';
import {
  diffFingerprints,
  type ObservationFingerprint,
  type PageDelta,
} from '../interaction/page-delta.js';
import type { AttemptRecord } from '../interaction/types.js';
import { intentsToWorkflowCandidates } from '../locator/candidate-codec.js';
import type { ElementDescription } from '../locator/types.js';
import { scrollContainerInPage } from '../widgets/scroll.js';
import type { ScrollFrame, WidgetContainer, WidgetPort } from '../widgets/types.js';

import {
  BrowserActionabilityError,
  hiddenError,
  StaleElementRefError,
} from './actionability-errors.js';
import {
  CANDIDATE_SCAN_CAP,
  CANDIDATE_SELECTOR,
  describeCandidatesInPage,
  OBSTRUCTION_CANDIDATE_CAP,
  selectObstructionCandidates,
  type ObstructionCandidate,
} from './obstruction.js';
import { dismissSiteOverlays, type OverlayDismissal } from './overlay-dismiss.js';
import {
  CLICK_NAV_DETECT_MS,
  FILL_NAV_DETECT_MS,
  isNavigationRaceError,
  PageSettler,
  REDIRECT_CHAIN_DETECT_MS,
  type NavigationWatch,
} from './page-settle.js';
import {
  dispatchAt,
  obstructionRootAtPoint,
  POINTER_SETTLE_MS,
  preparePointerTarget,
  type MintedCandidates,
  type PointerPoint,
} from './pointer-preflight.js';
import { SensitiveScreenLatch } from './sensitive-screen-latch.js';
import { wrapPuppeteerPage } from './session.js';
import {
  puppeteerSetOfMarksPort,
  withSetOfMarksCapture,
  type SetOfMarksMark,
} from './set-of-marks.js';
import type { BrowserProvider, BrowserSession, Logger, Page } from './types.js';

// Note: page settling (navigation watching, redirect chains, network quiet)
// and its error classifiers moved to `page-settle.ts` so that deterministic
// workflow replay waits exactly the way the agent does. They are deliberately
// NOT re-exported here — two `export *` barrels exposing the same name make it
// ambiguous, and ESM then silently omits it from the package entry point.

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
const STABILITY_POLL_MS = 25;

/** Human-scale per-key delay so debounced validators keep up; dropped for
 * long values so a large fill cannot blow the tool budget. */
const FILL_TYPE_DELAY_MS = 45;
const FILL_TYPE_DELAY_MAX_CHARS = 128;
/** The platform's select-all chord; Chrome maps Meta on macOS, Control elsewhere. */
const SELECT_ALL_MODIFIER: KeyInput = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Controls whether a click owns stale-identity recovery or exposes one attempt. */
export interface BrowserClickOptions {
  readonly healStale?: boolean;
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

/**
 * True when a popup is the opening page's own site continuing the same task.
 *
 * The test is host containment after dropping a leading `www.`, not a public-
 * suffix lookup: `www.kayak.com` opening `www.kayak.com`, and `google.com`
 * opening `accounts.google.com`, both pass, while `kayak.com` opening
 * `booking.com` does not — and neither does `bbc.co.uk` versus `evil.co.uk`,
 * which a naive "last two labels" rule would wave through. Only http(s)
 * qualifies; a `blob:`/`javascript:`/`about:` popup is not somewhere to
 * continue a run.
 */
export function isSameSitePopup(openerUrl: string, popupUrl: string): boolean {
  const opener = siteHost(openerUrl);
  const popup = siteHost(popupUrl);
  if (opener === null || popup === null) return false;
  return opener === popup || opener.endsWith(`.${popup}`) || popup.endsWith(`.${opener}`);
}

function siteHost(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (host.length === 0) return null;
  return host.startsWith('www.') ? host.slice(4) : host;
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

/** Raw private PNG captured by the controller before run-artifact persistence. */
export interface AgentScreenshotCapture {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly scope: 'viewport' | 'element';
  readonly ref?: string;
  readonly marks: number;
}

export interface BrowserActionResult {
  readonly url: string;
  readonly title: string;
  readonly popup_intercepted?: string;
  /**
   * Address of a popup the run is *holding open* and could continue in, set
   * alongside `popup_intercepted` when the site opened the tab on its own
   * domain. See {@link AgentBrowserController.adoptPopup} — the caller decides,
   * because switching tabs is a navigation and navigations are policy-checked.
   */
  readonly popup_followable?: string;
  /** Address the run switched to after {@link AgentBrowserController.adoptPopup}. */
  readonly switched_to_new_tab?: string;
  readonly dialog_intercepted?: string;
  /**
   * Site-raised overlays closed before this result was observed, omitted when
   * none were. Surfaced rather than done silently: the page the model is about
   * to read is not the page a person would have landed on.
   */
  readonly overlays_dismissed?: number;
  /**
   * Recovery the controller itself performed, omitted when it performed none.
   *
   * Today the only entry is the obstruction protocol's single
   * `clear-obstruction` press, recorded so a clearance the user did not ask for
   * is on the ledger like every other recovery step rather than invisible in a
   * result that merely says the click landed.
   */
  readonly attempted?: readonly AttemptRecord[];
}

interface InteractableRecord extends AgentInteractable {
  readonly handle: ElementHandle<Element>;
  /**
   * Where the element's root node is — internal diagnostics only.
   *
   * Deliberately kept off `AgentInteractable`: `browser-common.ts` forwards
   * `observation.interactables` to the model wholesale, so a field there is a
   * model-visible payload contract change that costs every observation bytes.
   * `describeRef` strips it for the same reason.
   *
   * Absent for a ref minted by a scan that does not report it — the
   * obstruction-scoped candidate mint uses a subtree-scoped flat query with its
   * own contract. Recording a scope it never measured would be a fabricated
   * diagnostic, and this field exists to answer a question honestly or not at
   * all.
   */
  readonly composedScope?: 'document' | 'open-shadow';
}

interface ElementIdentity {
  readonly role: string;
  readonly name: string;
  readonly group: string | null;
}

/** A popup held open for a possible adoption, with the address that opened it. */
interface RetainedPopup {
  readonly page: PuppeteerPage;
  /** The opener's URL at capture time — see {@link AgentBrowserController.followablePopupUrl}. */
  readonly openerUrl: string;
}

// The actionability error classes moved to `actionability-errors.ts` so the
// obstruction protocol can throw them without importing the controller that
// calls it. Re-exported here so every existing import site is unchanged.
export {
  BrowserActionabilityError,
  StaleElementRefError,
  type BrowserActionabilityCode,
} from './actionability-errors.js';

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
  /** Shared run-local latch consulted by secret fills and screenshot capture. */
  public readonly sensitiveScreenLatch = new SensitiveScreenLatch();

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
  /**
   * The one popup held open for a possible {@link adoptPopup}, or null.
   *
   * At most one, and it lives only until the next action: a tab nobody adopted
   * is a tab nobody wants, and bounding it here means no tool can leak one by
   * forgetting to decide.
   */
  private pendingPopup: RetainedPopup | null = null;
  private browserPopupListener: ((target: Target) => void) | null = null;
  private teardownPromise: Promise<void> | null = null;
  private lastDigestHash: string | null = null;
  /**
   * Marks the document the recorded identities were read from.
   *
   * A history-API navigation fires the same commit event as a real one but
   * keeps the document, so refs minted before it still name live elements and
   * are worth healing. Loading a new document destroys `window` and takes the
   * marker with it, which is exactly when an identity must not be reused: a
   * "Search" button on the next page is a different button. The marker
   * distinguishes the two without guessing from the event.
   */
  private documentMarker: string | null = null;
  /**
   * The fingerprint of the most recent scan, model-visible or not.
   *
   * Every `observe()` replaces it, because it is the *after* side of a delta
   * and a tool asking for one wants the page as it stands now.
   */
  private lastScanFingerprint: ObservationFingerprint | null = null;
  /**
   * The fingerprint of the frame the **model** last saw.
   *
   * Gated on the existing `trackDigest` flag, which already means "this is a
   * model-visible observation". Internal resolution reads — field resolution,
   * click re-acquisition, identity healing — must not silently replace it, or a
   * batch's delta would report the difference from a frame the model was never
   * shown. Reusing that flag rather than inventing a second one is deliberate:
   * a second flag is one every future internal caller would have to remember.
   */
  private deltaBaseline: ObservationFingerprint | null = null;
  /**
   * The baseline as it stood when this top-level tool call opened.
   *
   * Captured in {@link AgentBrowserController.beginToolCall} so a call that
   * observes many times — a `browser_fill_form` batch — still yields exactly
   * one delta, spanning the whole call.
   */
  private deltaCallBaseline: ObservationFingerprint | null = null;
  /**
   * Whether this top-level tool call has spent its one obstruction clearance.
   *
   * Reset by {@link AgentBrowserController.beginToolCall}; set **before** the
   * press so a throw inside the press cannot buy a second attempt.
   */
  private clearanceSpent = false;

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
    await this.discardPendingPopup();
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
    // The caller asked for a page, not for a dialog, so anything floating over
    // the document that just loaded is the site's and nobody's to keep. Doing
    // this only here is deliberate — see `overlay-dismiss.ts`.
    return this.currentActionResult(await this.dismissOverlays());
  }

  /** Close site-raised overlays without ever failing the navigation. */
  private async dismissOverlays(): Promise<OverlayDismissal | null> {
    try {
      return await dismissSiteOverlays(this);
    } catch (error) {
      this.logger?.debug?.(
        { err: error instanceof Error ? error.message : String(error) },
        'overlay dismissal skipped',
      );
      return null;
    }
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
    const trackDigest = options.trackDigest ?? true;
    const cap = Math.max(
      1,
      Math.min(Math.floor(options.cap ?? this.maxInteractables), MAX_RESOLUTION_INTERACTABLES),
    );
    // One composed-tree pass produces the records *and* the elements they
    // describe. The pair this replaced — a record-only scan plus an independent
    // `page.$$` handle query — could only be held in step by convention, and a
    // drift bound every ref to the wrong element without failing loudly.
    // Injection first, because the scan's accessible-name step prefers the
    // locator runtime and falls back to its smaller offline computation.
    await ensureLocatorRuntime(this.pageFacade!);
    const { records, elements: scanned } = await collectComposedInteractables(this.page!, {
      max: MAX_RESOLUTION_INTERACTABLES,
    });
    const snapshot = await buildAgentPageSnapshot(
      this.pageFacade!,
      { extractor: this.extractor },
      {
        maxDigestBytes: this.maxDigestBytes,
        maxInteractables: cap,
        records,
      },
    );
    // Stamp the document these identities are being read from, so a later heal
    // can tell an in-page route change (marker survives) from a real navigation
    // (new window, marker gone) without trusting the commit event alone.
    this.documentMarker = await this.stampDocument();
    // The epoch is the controller's to supply — it is the only component that
    // stamps and reads the marker — so the builder's fingerprint is completed
    // here rather than being handed a page facade of its own.
    const fingerprint: ObservationFingerprint = {
      ...snapshot.fingerprint,
      epoch: this.documentMarker,
    };
    this.lastScanFingerprint = fingerprint;
    if (trackDigest) this.deltaBaseline = fingerprint;
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
      const handle = scanned[raw.elementIndex];
      if (!handle || claimed.has(handle)) continue;
      const role = raw.role;
      const name = raw.name ?? '';
      const ordinalKey = `${role}\u0000${name}`;
      const ordinal = ordinals.get(ordinalKey) ?? 0;
      ordinals.set(ordinalKey, ordinal + 1);
      const identity = `${ordinalKey}\u0000${ordinal}`;
      let ref = this.refIdByIdentity.get(identity);
      if (!ref) {
        ref = `e${this.nextRef++}`;
        this.refIdByIdentity.set(identity, ref);
      }
      claimed.add(handle);
      const projected = projectAgentInteractable(ref, raw);
      this.refs.set(ref, { ...projected, handle, composedScope: raw.composedScope });
      this.identityByRef.set(ref, {
        role: projected.role,
        name: projected.name,
        group: projected.group ?? null,
      });
      interactables.push(projected);
    }
    for (const record of superseded.values()) disposeHandle(record.handle);
    for (const handle of scanned) {
      if (handle && !claimed.has(handle)) disposeHandle(handle);
    }
    // Structural scope only, and by construction: the token is a literal and
    // the value is a count, so no host, brand, or page text can reach the log.
    this.logger?.debug?.(
      {
        runId: this.runId,
        interactables: interactables.length,
        openShadow: records.filter((record) => record.composedScope === 'open-shadow').length,
      },
      'observed interactables',
    );
    const digestHash = createHash('sha256').update(snapshot.digest).digest('hex').slice(0, 16);
    const digestUnchanged = trackDigest && digestHash === this.lastDigestHash;
    if (trackDigest && !digestUnchanged) this.lastDigestHash = digestHash;
    return {
      ...snapshot,
      digest: digestUnchanged ? '' : snapshot.digest,
      digestUnchanged,
      interactables,
    };
  }

  /**
   * Advance a widget container's own scrollable region by one step.
   *
   * A mutating action, counted like any other. Reachable only from a driver's
   * `drive()`; detection must never move the page.
   */
  public async scrollContainer(
    container: WidgetContainer,
    step?: number,
  ): Promise<ScrollFrame | null> {
    this.assertLaunched();
    return this.evaluate(scrollContainerInPage, container.path, step ?? null);
  }

  /** Resolve a live opaque ref minted on the current document. */
  public resolveRef(ref: string): ElementHandle<Element> {
    const record = this.refs.get(ref);
    if (!record) throw new StaleElementRefError(ref);
    return record.handle;
  }

  /** Capture an epoch-guarded PNG with Yantra's current eNN marks overlaid. */
  public async capturePng(ref?: string): Promise<AgentScreenshotCapture> {
    this.assertLaunched();
    const page = this.page!;
    const target = ref === undefined ? null : this.resolveRef(ref);
    const marks: SetOfMarksMark[] = [];
    for (const [markRef, record] of this.refs) {
      const box = await record.handle.boundingBox();
      if (box !== null) {
        marks.push({ ref: markRef, left: box.x, top: box.y, width: box.width, height: box.height });
      }
    }
    const targetBox = target === null ? null : await target.boundingBox();
    if (target !== null && targetBox === null) throw new StaleElementRefError(ref!);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const rawClip = targetBox ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
    const clip = {
      x: Math.max(0, rawClip.x),
      y: Math.max(0, rawClip.y),
      width: Math.max(1, Math.min(1600, rawClip.width)),
      height: Math.max(1, Math.min(1200, rawClip.height)),
      scale: 1,
    };
    const png = await withSetOfMarksCapture({
      port: puppeteerSetOfMarksPort(page),
      marks,
      readTopLevelEpoch: () => this.topLevelDocumentEpoch(),
      capture: async () => {
        const session = await page.createCDPSession();
        try {
          const result = await session.send('Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: target !== null,
            clip,
          });
          return Buffer.from(result.data, 'base64');
        } finally {
          await session.detach().catch(() => undefined);
        }
      },
    });
    const dimensions = pngDimensions(png);
    return {
      png,
      ...dimensions,
      scope: target === null ? 'viewport' : 'element',
      ...(ref === undefined ? {} : { ref }),
      marks: marks.length,
    };
  }

  /** Return model-safe ref metadata for policy classification. */
  public describeRef(ref: string): AgentInteractable | undefined {
    const record = this.refs.get(ref);
    if (!record) return undefined;
    const { handle: _handle, composedScope: _composedScope, ...described } = record;
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

  /**
   * Open a new top-level tool call, resetting the one obstruction clearance.
   *
   * The allowance is per **tool call**, not per action: `browser_fill_form` is
   * one call spanning many fields and many typing rungs, and all of them share
   * a single automatic dismissal. The middleware calls this immediately before
   * a tool's domain operation because that is the only place in the system that
   * knows where a top-level call starts — putting the reset in each tool would
   * make the bound depend on every future tool remembering to declare it.
   */
  public beginToolCall(): void {
    this.clearanceSpent = false;
    // One delta per top-level call, not one per action: a batch that fills four
    // fields compares the page the model last saw with the page the batch left
    // behind. Pinning the baseline here is what makes that a property of the
    // call rather than of whichever action happened to run last.
    this.deltaCallBaseline = this.deltaBaseline;
  }

  /**
   * What changed between the frame the model last saw and the current one.
   *
   * Takes **no page read**: both fingerprints were derived inside observations
   * the caller had already taken. Returns `null` when there was no baseline to
   * diff against — the ordinary state of the first navigation in a run — so the
   * caller can record why the block is absent rather than emitting an empty
   * one that reads as "nothing changed".
   *
   * The result describes what changed in the action window, not proof that the
   * action caused it. See {@link PageDelta}.
   */
  public deltaSinceBaseline(): PageDelta | null {
    const before = this.deltaCallBaseline;
    const after = this.lastScanFingerprint;
    if (!before || !after) return null;
    return diffFingerprints(before, after);
  }

  /**
   * Drain whatever the page raised since the last action result was built.
   *
   * **Synchronous, and takes no page read.** It exists so a popup, a JS dialog,
   * or a landing URL produced *by a fill* is attributed to the fill rather than
   * leaking forward onto whatever tool runs next — the leak recorded in
   * `TODO.md`'s popup follow-ups. It is a plain drain with no retry, budget, or
   * ordering semantics of its own.
   */
  public takeActionMetadata(): BrowserActionResult {
    const popup = this.popupUrls.shift();
    const dialog = this.dialogMessages.shift();
    const followable = this.followablePopupUrl();
    return {
      url: this.page?.url() ?? '',
      title: this.lastScanFingerprint?.title ?? '',
      ...(popup ? { popup_intercepted: popup } : {}),
      ...(followable ? { popup_followable: followable } : {}),
      ...(dialog ? { dialog_intercepted: dialog } : {}),
    };
  }

  /**
   * Scroll, settle, prove the click point is ours, and clear one overlay at most.
   *
   * Everything genuinely diagnostic — the candidate scan, the classification
   * describe, the clearance — happens only after interception is detected. The
   * hit test itself is not a diagnostic: it is the check that authorizes a
   * pointer action, and it costs one round trip on every pointer dispatch.
   */
  private preparePointer(
    handle: ElementHandle<Element>,
    ref: string,
  ): Promise<{ readonly point: PointerPoint; readonly attempted: readonly AttemptRecord[] }> {
    const page = this.page!;
    return preparePointerTarget({
      page,
      handle,
      mintCandidates: (point, rootLevels) => this.mintObstructionCandidates(point, rootLevels),
      clearanceSpent: () => this.clearanceSpent,
      spendClearance: () => {
        this.clearanceSpent = true;
      },
      pressCandidate: async (candidateRef) => {
        const candidate = this.resolveRef(candidateRef);
        // No recursion: the candidate gets the same hover/settle/point sequence,
        // but if it is itself covered the clearance simply fails. A chain of
        // clearances is the loop the one-per-call bound exists to prevent.
        await candidate.hover();
        await sleep(POINTER_SETTLE_MS);
        const point = await candidate.clickablePoint();
        await dispatchAt(page, { x: point.x, y: point.y }, { delay: CLICK_HOLD_MS });
      },
      settle: () => this.awaitReadable(),
      now: () => Date.now(),
    }).catch((error: unknown) => {
      if (isNavigationRaceError(error)) throw new StaleElementRefError(ref);
      if (isNoLayoutBoxError(error)) throw hiddenError();
      throw error;
    });
  }

  /**
   * Mint the obstructing subtree's own dismiss controls as real refs.
   *
   * Two properties make the offer honest, and both are structural rather than
   * conventional. **Containment**: the scan starts at the obstruction root and
   * never queries the page, so a "Close" button elsewhere is not this overlay's
   * dismiss control. **Resolvability**: each survivor is registered in the live
   * ref map, so an offered ref is a ref `browser_click` can act on — which is
   * what makes naming it in a hint legal at all.
   *
   * Registration is deliberately **additive**. It does not write
   * `refIdByIdentity`, because a subtree-scoped ordinal is not comparable with
   * the page-scoped one `observe()` assigns and reusing the index could alias an
   * existing ref onto a different element; and it does not replace the ref map,
   * because that would invalidate the very ref the caller is acting on.
   */
  private async mintObstructionCandidates(
    point: PointerPoint,
    rootLevels: number,
  ): Promise<MintedCandidates> {
    const empty: MintedCandidates = { candidates: [], truncated: false };
    const page = this.page!;
    const rootHandle = (
      await page.evaluateHandle(obstructionRootAtPoint, point.x, point.y, rootLevels)
    ).asElement() as ElementHandle<Element> | null;
    if (!rootHandle) return empty;
    try {
      const scanned = (await rootHandle.$$(CANDIDATE_SELECTOR)).slice(0, CANDIDATE_SCAN_CAP);
      if (scanned.length === 0) return empty;
      // One evaluate over the handles the caller already holds: metadata and
      // handles come from the same traversal, so no index can drift between them.
      const describe = this.evaluate.bind(this) as unknown as (
        fn: (...elements: readonly Element[]) => readonly { role: string; name: string }[],
        ...handles: readonly ElementHandle<Element>[]
      ) => Promise<readonly { readonly role: string; readonly name: string }[]>;
      const described = await describe(describeCandidatesInPage, ...scanned);
      const selection = selectObstructionCandidates(
        described.map((entry, index) => ({ role: entry.role, name: entry.name, index })),
      );
      const candidates: ObstructionCandidate[] = [];
      const claimed = new Set<number>();
      for (const entry of selection.selected) {
        const handle = scanned[entry.index];
        if (!handle) continue;
        const ref = `e${this.nextRef++}`;
        const projected: AgentInteractable = { ref, role: entry.role, name: entry.name };
        this.refs.set(ref, { ...projected, handle });
        this.identityByRef.set(ref, { role: entry.role, name: entry.name, group: null });
        claimed.add(entry.index);
        candidates.push({
          ref,
          role: entry.role,
          name: entry.name,
          protectedAction: entry.protectedAction,
          autoClearable: entry.autoClearable,
        });
        if (candidates.length >= OBSTRUCTION_CANDIDATE_CAP) break;
      }
      for (const [index, handle] of scanned.entries()) {
        if (!claimed.has(index)) disposeHandle(handle);
      }
      return { candidates, truncated: selection.truncated };
    } catch (error) {
      // A subtree that cannot be read still produces a report; it simply
      // produces one with no candidates rather than turning a typed
      // actionability failure into an unexpected crash.
      this.logger?.debug?.(
        { err: error instanceof Error ? error.message : String(error) },
        'obstruction candidate minting skipped',
      );
      return empty;
    } finally {
      disposeHandle(rootHandle);
    }
  }

  /** Click a current ref after deterministic visibility/hit-target checks. */
  public async click(ref: string, options: BrowserClickOptions = {}): Promise<BrowserActionResult> {
    if (options.healStale === false) return this.clickOnce(ref);
    return this.withIdentityHealing(ref, () => this.clickOnce(ref));
  }

  private async clickOnce(ref: string): Promise<BrowserActionResult> {
    const handle = this.resolveRef(ref);
    await assertActionable(handle, ref);
    /** The `clear-obstruction` record, when the pre-flight had to clear one. */
    let attempted: readonly AttemptRecord[] = [];
    // Whatever the previous action opened and nobody adopted is stale now.
    await this.discardPendingPopup();
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
        // time to settle, then prove the resulting click point belongs to this
        // element, then dispatch a held press (down, pause, up) at THAT point.
        const prepared = await this.preparePointer(handle, ref);
        attempted = prepared.attempted;
        await dispatchAt(page, prepared.point, { delay: CLICK_HOLD_MS });
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
    return this.currentActionResult(null, attempted);
  }

  /** Fill a current ref without returning or logging the supplied value. */
  public async fill(ref: string, value: string): Promise<BrowserActionResult> {
    return this.withIdentityHealing(ref, () => this.fillOnce(ref, value));
  }

  private async fillOnce(ref: string, value: string): Promise<BrowserActionResult> {
    const handle = this.resolveRef(ref);
    await assertActionable(handle, ref);
    await this.discardPendingPopup();
    const page = this.page!;
    let attempted: readonly AttemptRecord[] = [];
    const watch = this.watchNavigation();
    try {
      try {
        // A native <select> is filled by value, not by pointer, so it never
        // reaches the pre-flight: pointer reachability is a guarantee about
        // pointer dispatch, and `fillSelect` dispatches none.
        if (!(await this.selectOption(handle, ref, value))) {
          const prepared = await this.preparePointer(handle, ref);
          attempted = prepared.attempted;
          await handle.focus();
          // Select-all via triple-click, then overtype: replaces any existing
          // value with real mouse/key events, which framework listeners require.
          await dispatchAt(page, prepared.point, { count: 3, delay: CLICK_HOLD_MS });
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
    return this.currentActionResult(null, attempted);
  }

  /** Empty a text control with real selection + delete key events. */
  public async clear(ref: string): Promise<BrowserActionResult> {
    return this.withIdentityHealing(ref, () => this.clearOnce(ref));
  }

  private async clearOnce(ref: string): Promise<BrowserActionResult> {
    const handle = this.resolveRef(ref);
    await assertActionable(handle, ref);
    const watch = this.watchNavigation();
    try {
      try {
        await handle.focus();
        // Select-all through the platform chord rather than `element.value = ''`:
        // a framework-controlled input ignores a direct assignment it did not
        // author, and reinstates its own value on the next render.
        await this.page!.keyboard.down(SELECT_ALL_MODIFIER);
        await this.page!.keyboard.press('a');
        await this.page!.keyboard.up(SELECT_ALL_MODIFIER);
        await this.page!.keyboard.press('Backspace');
      } catch (error) {
        if (isNoLayoutBoxError(error)) throw hiddenError();
        if (isNavigationRaceError(error)) throw new StaleElementRefError(ref);
        throw error;
      }
      await this.awaitPageStable(watch, FILL_NAV_DETECT_MS);
    } finally {
      watch.dispose();
    }
    return this.currentActionResult();
  }

  /** Type into a control at a caller-chosen pace, without clearing it first. */
  public async type(
    ref: string,
    text: string,
    options: { readonly delayMs?: number } = {},
  ): Promise<BrowserActionResult> {
    return this.withIdentityHealing(ref, () => this.typeOnce(ref, text, options));
  }

  private async typeOnce(
    ref: string,
    text: string,
    options: { readonly delayMs?: number },
  ): Promise<BrowserActionResult> {
    const handle = this.resolveRef(ref);
    await assertActionable(handle, ref);
    const watch = this.watchNavigation();
    try {
      try {
        await handle.focus();
        await handle.type(text, { delay: options.delayMs ?? typeDelayFor(text) });
      } catch (error) {
        if (isNoLayoutBoxError(error)) throw hiddenError();
        if (isNavigationRaceError(error)) throw new StaleElementRefError(ref);
        throw error;
      }
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
  public async selectOption(
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
    if (outcome === 'no_match') {
      assertReceivable('actionability', 'OPTION_NOT_FOUND', 'option-not-found', 'option');
      throw new BrowserActionabilityError(
        'OPTION_NOT_FOUND',
        renderInteractionMessage('actionability', 'OPTION_NOT_FOUND', 'option-not-found', {})
          .message,
      );
    }
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

  /** Current top-level committed-document epoch, or null before/unreadable launch. */
  public topLevelDocumentEpoch(): number | null {
    return this.settler?.epoch ?? null;
  }

  /** Close Chrome and remove the ephemeral profile. Idempotent. */
  public teardown(): Promise<void> {
    this.sensitiveScreenLatch.clearOnTeardown();
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
        // `identityByRef` deliberately survives: this event cannot tell a
        // history-API navigation from a real one, and single-page sites fire it
        // while every element stays put. Healing checks the document marker
        // before trusting an identity, so a genuine document swap still refuses
        // — without discarding recovery on every in-page route change.
        this.lastDigestHash = null;
      },
    });

    // Registered against the browser, not the page, so it has to survive a
    // page swap (adoption) without being installed twice — a second copy would
    // capture, and close, the same popup from a listener whose page is gone.
    // Keying on the *live* page keeps one listener correct across every swap.
    if (this.browserPopupListener === null) {
      this.browserPopupListener = (target: Target): void => {
        const current = this.page;
        if (!current || target.opener() !== current.target()) return;
        // Intercepting a popup does not change the main document, so the main
        // page's refs stay valid.
        void this.capturePopupTarget(target);
      };
      page.browser().on('targetcreated', this.browserPopupListener);
    }
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
      if (!url || url === 'about:blank') {
        await popup.close().catch(() => undefined);
        return;
      }
      this.popupUrls.push(url);
      // A tab the site opened on its own domain is where it just sent the run:
      // the results of the search that was submitted, carrying state the URL
      // alone often cannot reproduce. Hold it open so the caller can adopt it
      // after a policy check. A third-party popup is an interstitial or an ad
      // and is closed on sight, exactly as before.
      const openerUrl = this.page?.url() ?? '';
      if (isSameSitePopup(openerUrl, url)) {
        await this.retainPopup({ page: popup, openerUrl });
        return;
      }
      await popup.close().catch(() => undefined);
    })();
    this.popupCaptureByTarget.set(target, task);
    this.popupCaptureTasks.add(task);
    void task.finally(() => this.popupCaptureTasks.delete(task));
    return task;
  }

  private async retainPopup(retained: RetainedPopup): Promise<void> {
    const previous = this.pendingPopup;
    this.pendingPopup = retained;
    if (previous && previous.page !== retained.page) {
      await previous.page.close().catch(() => undefined);
    }
  }

  /**
   * Live address of the held popup while it is still worth following, or null.
   *
   * Re-tested rather than remembered, because the tab keeps moving after it is
   * captured: a site that opens its results and then bounces that tab onto a
   * partner has not handed the run its results. The comparison is against the
   * URL the *opener* had when the popup was created — the opener's own address
   * is no use here, since bouncing the opener onto a partner is the other half
   * of the same trick, and reading it live would refuse exactly the case this
   * exists for (KAYAK sends the opener to vrbo.com as its results tab opens).
   */
  public followablePopupUrl(): string | null {
    const retained = this.pendingPopup;
    if (!retained || retained.page.isClosed()) return null;
    const url = retained.page.url();
    if (!url || url === 'about:blank') return null;
    return isSameSitePopup(retained.openerUrl, url) ? url : null;
  }

  /**
   * Continue the run in the popup the last action opened, closing the tab it
   * came from.
   *
   * The caller — not this controller — decides whether to call: landing on a
   * new address is a navigation, and every navigation in this system passes URL
   * provenance, host policy, and the ethics gate first. What is settled here is
   * only the mechanics, and one fact the caller cannot see: the popup must
   * still be the same-site tab that was captured, so a page that redirected it
   * onto a partner domain in the meantime is refused rather than followed.
   *
   * Adopting replaces the document, so every ref minted before it is dead —
   * the same contract as any other navigation.
   *
   * @returns The action result for the adopted tab, or null when there is no
   *   popup left to adopt (it closed, or it moved off-site).
   */
  public async adoptPopup(): Promise<BrowserActionResult | null> {
    const retained = this.pendingPopup;
    const opener = this.page;
    if (!retained || !opener || this.followablePopupUrl() === null) return null;
    const popup = retained.page;

    this.pendingPopup = null;
    this.invalidateObservation();
    this.refIdByIdentity.clear();
    this.identityByRef.clear();
    this.documentMarker = null;
    this.lastDigestHash = null;
    this.settler?.dispose();
    this.settler = null;

    this.page = popup;
    this.pageFacade = wrapPuppeteerPage(popup);
    this.installPagePolicies(popup);
    // A background tab is throttled by Chrome; the run's page has to be the
    // foreground one or every later wait measures the wrong page.
    await popup.bringToFront().catch(() => undefined);
    await opener.close().catch(() => undefined);
    // Drained *after* the opener is gone, then dropped: popups and dialogs it
    // raised describe the page being left, whose result has already been
    // returned, and the one still in flight here is reliably the monetization
    // redirect the site sent the opener to as it opened this tab. Reporting it
    // hands the model a second address to chase off the page it just landed on.
    await Promise.allSettled([...this.popupCaptureTasks]);
    this.popupUrls = [];
    this.dialogMessages = [];
    await this.awaitReadable();
    const overlays = await this.dismissOverlays();
    // A popup the adopted page raises while it is loading is a partner or ad
    // impression by construction — it is cross-site, or it would have been
    // retained instead — and reporting it alongside the switch gives the model
    // two destinations for one action, one of which it is told elsewhere to
    // follow. It belongs to the next action's result, not to arriving here.
    const { popup_intercepted: _partner, ...result } = await this.currentActionResult(overlays);
    this.logger?.info({ runId: this.runId, url: result.url }, 'adopted site-opened tab');
    return { ...result, switched_to_new_tab: result.url };
  }

  /** Close a popup nobody adopted. Called before the next action and at teardown. */
  private async discardPendingPopup(): Promise<void> {
    const retained = this.pendingPopup;
    this.pendingPopup = null;
    if (retained) await retained.page.close().catch(() => undefined);
  }

  private invalidateObservation(): void {
    for (const record of this.refs.values()) disposeHandle(record.handle);
    this.refs.clear();
  }

  /**
   * Re-read the marker stamped on the document the identities came from.
   *
   * Returns false once the document has been replaced, which is the only case
   * where a recorded identity may name a different element than it did.
   */
  /**
   * Read the live document's marker, minting one if it has none.
   *
   * Read-or-mint rather than always-write, so the marker is a stable **epoch**:
   * two observations of the same document report the same value, and only a
   * replaced document (which destroys `window` and the marker with it) reports
   * a different one. That is exactly the signal a delta needs to know whether
   * the two frames' controls are comparable at all.
   *
   * `isSameDocument()`'s semantics are unchanged — present-and-equal means the
   * same document — and so is the number of `evaluate` calls per `observe()`:
   * the read and the mint are the same round trip.
   *
   * @returns The document's epoch, or `null` when the page refuses the stamp.
   */
  private async stampDocument(): Promise<string | null> {
    const minted = `y${Math.random().toString(36).slice(2)}`;
    try {
      return await this.evaluate((value: string) => {
        const globals = globalThis as { __yantraDocument?: string };
        if (typeof globals.__yantraDocument === 'string') return globals.__yantraDocument;
        globals.__yantraDocument = value;
        return value;
      }, minted);
    } catch {
      return null;
    }
  }

  private async isSameDocument(): Promise<boolean> {
    if (this.documentMarker === null) return false;
    try {
      const seen = await this.evaluate(
        () => (globalThis as { __yantraDocument?: string }).__yantraDocument ?? null,
      );
      return seen === this.documentMarker;
    } catch {
      return false;
    }
  }

  private async withIdentityHealing<T>(ref: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof StaleElementRefError)) throw error;
      const identity = this.identityByRef.get(ref);
      if (!identity) throw error;
      if (!(await this.isSameDocument())) {
        this.identityByRef.clear();
        throw new StaleElementRefError(ref, 'the page navigated to a new document');
      }
      const observation = await this.observe({
        cap: MAX_RESOLUTION_INTERACTABLES,
        trackDigest: false,
      });
      const named = observation.interactables.filter(
        (entry) => entry.role === identity.role && entry.name === identity.name,
      );
      if (named.length === 0) {
        throw new StaleElementRefError(ref, 'element left the page');
      }
      // Several live elements can legitimately share one identity: opening a
      // picker or a filter panel routinely mounts a second copy of the control
      // that opened it, and the copies mirror each other. Refusing there
      // stranded the caller on exactly the sites where recovery matters most,
      // so the group narrows the field and document order settles the rest.
      // This re-finds an element the caller already named; it never decides
      // which element the caller meant.
      const grouped = named.filter((entry) => (entry.group ?? null) === identity.group);
      const chosen = (grouped.length > 0 ? grouped : named)[0]!;
      this.rebindRef(ref, chosen.ref, identity);
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

  private async currentActionResult(
    overlays: OverlayDismissal | null = null,
    attempted: readonly AttemptRecord[] = [],
  ): Promise<BrowserActionResult> {
    await settle();
    await Promise.allSettled([...this.popupCaptureTasks]);
    const popup = this.popupUrls.shift();
    const dialog = this.dialogMessages.shift();
    const title = await this.currentTitle();
    let result: BrowserActionResult = { url: this.page?.url() ?? '', title };
    if (popup) result = { ...result, popup_intercepted: popup };
    const followable = this.followablePopupUrl();
    if (followable) result = { ...result, popup_followable: followable };
    if (dialog) result = { ...result, dialog_intercepted: dialog };
    if (overlays && overlays.dismissed > 0)
      result = { ...result, overlays_dismissed: overlays.dismissed };
    if (attempted.length > 0) result = { ...result, attempted: [...attempted] };
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
    await this.discardPendingPopup();
    const listener = this.browserPopupListener;
    this.browserPopupListener = null;
    if (listener && this.page) {
      try {
        this.page.browser().off('targetcreated', listener);
      } catch {
        // The browser is already gone; nothing to detach from.
      }
    }
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
      renderInteractionMessage('actionability', 'ELEMENT_DISABLED', 'disabled', {}).message,
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

function pngDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('Chrome returned an invalid PNG screenshot.');
  }
  const view = Buffer.from(bytes);
  const width = view.readUInt32BE(16);
  const height = view.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error('Chrome returned invalid PNG dimensions.');
  return { width, height };
}
