/**
 * Post-action page settling, shared by the agentic browser tools and
 * deterministic workflow replay.
 *
 * A click on a real site is not finished when `click()` resolves. The site may
 * start its navigation on a timer, chain client-side redirects, or fetch the
 * result and paint it seconds later — a carrier tracking page commonly takes
 * 10-30s to populate. Whoever acts next (the agent's observation, or the
 * workflow's next step) must not race that.
 *
 * This module owns the whole bounded wait so that **both** paths get the same
 * behavior. Replay previously had none of it: `handleClick` clicked and
 * returned immediately, so a promoted workflow read its result page before the
 * result existed. Any future tuning here — the unsettleable-scheme filter, the
 * stale-request cutoff — now lands on both paths at once.
 *
 * Every phase is bounded. A page that never settles degrades to a result after
 * the caps rather than raising.
 */

import type { HTTPRequest, Page as PuppeteerPage } from 'puppeteer-core';

/** Time to wait for a navigation that has already started (request fired) to
 * commit (server responds, frame swaps). This is response-header latency, not
 * full page load — content settling after commit is bounded separately below. */
const NAVIGATION_COMMIT_WAIT_MS = 20_000;
/** Follow-up client-side redirects re-trigger quickly on the new document. */
export const REDIRECT_CHAIN_DETECT_MS = 300;
/** How long after a click to keep watching for a navigation the site starts
 * late — async handlers, setTimeout redirects, validation-then-submit. */
export const CLICK_NAV_DETECT_MS = 800;
/** Fills navigate far more rarely (search-as-you-type, auto-submit), so their
 * watch window is shorter. */
export const FILL_NAV_DETECT_MS = 250;
/**
 * Hard cap on one action's whole stabilization (redirect chains included).
 * Sized to ~60s so a click/fill that triggers a slow-loading result page (a
 * carrier tracking page can take 10-30s to populate) is not reported back
 * before the content actually exists.
 */
const POST_ACTION_TOTAL_WAIT_MS = 60_000;
/**
 * Hard cap on settling a READ (observe/extract). Reads are the only view of
 * the page, so one taken while a document is still loading shows a blank or
 * half-built DOM — the caller concludes the content it needs is missing.
 * Matches the post-action cap: a page still populating when it happens to be
 * read (rather than immediately after the action that started the load)
 * deserves the same patience.
 */
const READ_SETTLE_TOTAL_MS = 60_000;
const STABILITY_POLL_MS = 25;
const DOM_READY_POLL_MS = 100;
/**
 * Network-quiet window and cap. Strict idle (0 in-flight): a single fetch
 * carrying the action's outcome must be waited for.
 *
 * The cap is sized to ~60s, not a few seconds: it is always clamped to
 * whatever remains of the caller's overall deadline, so it never lengthens a
 * fast page — but a slow one (a tracking page whose result loads via one
 * long-running fetch) needs this window to be as large as the overall budget,
 * not a small fraction of it.
 *
 * A cap this large only stays affordable while it is genuinely unreachable on
 * an idle page, so what counts as in-flight is defined narrowly — see
 * {@link UNSETTLEABLE_REQUEST_RE} and {@link INFLIGHT_STALE_MS}.
 */
const NETWORK_QUIET_IDLE_MS = 300;
const NETWORK_QUIET_TIMEOUT_MS = 60_000;
const NETWORK_QUIET_MAX_INFLIGHT = 0;
/**
 * Renderer-served URLs, whose requests are reported to the page but whose
 * completion may never be: the response arrives on the consuming context (a
 * worker's own target), so a page-level listener hears the start and nothing
 * else. The everyday case is the blob-backed worker that bot-protection and
 * analytics bundles spawn on most commercial sites — ups.com carries two,
 * observed open indefinitely — and each one pins a strict in-flight counter
 * above zero for the life of the document. That is what turned the quiet *cap*
 * into a quiet *floor*: every browser call paid the full ~60s.
 */
const UNSETTLEABLE_REQUEST_RE = /^(?:blob|data|filesystem):/i;
/**
 * A request still open after this long is a stream the page keeps alive (SSE,
 * long-poll, a hanging beacon), not the action's outcome. It stops counting
 * toward quiet at this age so one such connection cannot hold every later call
 * open to the cap for the rest of the run.
 */
const INFLIGHT_STALE_MS = 10_000;

/** True for a URL whose request may never report completion to the page. */
export function isUnsettleableRequestUrl(url: string): boolean {
  return UNSETTLEABLE_REQUEST_RE.test(url);
}

/**
 * Puppeteer failures caused by the document changing underneath an in-flight
 * call (navigation committing, a node being detached, or a handle disposed by
 * the navigation listener). These are races with the page, not bugs, and are
 * resolved by re-checking what the page actually did.
 */
const NAVIGATION_RACE_MESSAGE_RE =
  /execution context was destroyed|cannot find context with specified id|node is detached|detached frame|frame got detached|jshandle is disposed/i;

/** True for Puppeteer errors caused by the document changing mid-call. */
export function isNavigationRaceError(error: unknown): error is Error {
  return error instanceof Error && NAVIGATION_RACE_MESSAGE_RE.test(error.message);
}

/** Live view of whether an action set a main-frame navigation in motion. */
export interface NavigationWatch {
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

/** Optional hooks for owners that need to react to the page's own events. */
export interface PageSettlerOptions {
  /**
   * Called on every committed main-frame navigation. The agent controller uses
   * it to invalidate opaque element refs, which are only truly dead at that
   * moment.
   */
  readonly onNavigationCommitted?: () => void;
}

/**
 * Owns the in-flight bookkeeping and navigation epoch for one page, and the
 * bounded waits built on them.
 *
 * Attach exactly one per page, immediately after the page is created — the
 * request listeners only hear what starts after they are installed.
 */
export class PageSettler {
  private navigationEpoch = 0;
  /** Countable in-flight requests → their start time; see `quietInflight`. */
  private readonly inflight = new Map<HTTPRequest, number>();
  private readonly detach: () => void;

  public constructor(
    private readonly page: PuppeteerPage,
    options: PageSettlerOptions = {},
  ) {
    // Own the in-flight bookkeeping rather than reading Puppeteer's counter:
    // its counter has no way to discount a request that will never report
    // completion, and one such request makes strict idle unreachable forever.
    const onRequest = (request: HTTPRequest): void => {
      if (isUnsettleableRequestUrl(request.url())) return;
      this.inflight.set(request, Date.now());
    };
    const settled = (request: HTTPRequest): void => void this.inflight.delete(request);
    const onResponse = (response: { request(): HTTPRequest }): void => settled(response.request());
    const onFrameNavigated = (frame: unknown): void => {
      if (frame !== page.mainFrame()) return;
      this.navigationEpoch += 1;
      options.onNavigationCommitted?.();
    };

    page.on('request', onRequest);
    page.on('requestfinished', settled);
    page.on('requestfailed', settled);
    // Response headers are enough: the body may keep streaming (a download, a
    // media segment), but what the action did is already decided by then.
    page.on('response', onResponse);
    page.on('framenavigated', onFrameNavigated);

    this.detach = (): void => {
      page.off('request', onRequest);
      page.off('requestfinished', settled);
      page.off('requestfailed', settled);
      page.off('response', onResponse);
      page.off('framenavigated', onFrameNavigated);
    };
  }

  /**
   * Start watching for a main-frame navigation caused by an action. Installed
   * BEFORE the action is dispatched so a synchronously started navigation
   * cannot slip between the action and the watch.
   */
  public watch(): NavigationWatch {
    const page = this.page;
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

  /** The current committed-navigation counter. */
  public get epoch(): number {
    return this.navigationEpoch;
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
   *    (SPA actions that never navigate) have landed before the next read.
   */
  public async settleAfterAction(watch: NavigationWatch, graceMs: number): Promise<void> {
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
   * Resolve whether an action that threw a context-destroyed error actually
   * landed. That error only arises while a new document is committing, so wait
   * (bounded) for the commit to register as a navigation-epoch bump. Waiting
   * continues only while a main-frame request is still in flight; once it
   * aborts — or if there was never one (a coincidental node detach) — no commit
   * is coming, so the action did not land. Requiring the commit, not a mere
   * in-flight request, keeps an unrelated navigation from being mistaken for
   * the action's outcome.
   */
  public async awaitCommit(watch: NavigationWatch): Promise<boolean> {
    const deadline = Date.now() + NAVIGATION_COMMIT_WAIT_MS;
    while (this.navigationEpoch === watch.epoch()) {
      if (!watch.navigationPending() || Date.now() >= deadline) break;
      await sleep(STABILITY_POLL_MS);
    }
    return this.navigationEpoch !== watch.epoch();
  }

  /**
   * Hold a READ (observe/extract/assert) until the page is done loading.
   *
   * Actions settle themselves before returning, but a read is not necessarily
   * preceded by an action: a load started elsewhere may still be in flight — a
   * slow first paint, a redirect chain the action's own window did not
   * outlast, or an SPA route still fetching.
   *
   * Waiting on `document.readyState` rather than a navigation watch is what
   * makes this work for a load already in flight: a freshly installed watch
   * only hears requests that start after it, whereas `readyState` reports the
   * document's actual state right now. The network-quiet tail then lets
   * fetch/XHR-driven content land.
   */
  public async settleBeforeRead(): Promise<void> {
    const deadline = Date.now() + READ_SETTLE_TOTAL_MS;
    await this.awaitDomReady(READ_SETTLE_TOTAL_MS);
    await this.awaitNetworkQuiet(deadline);
  }

  /** Wait (bounded) for the current document to leave `loading`. */
  public async awaitDomReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.page.evaluate(() => document.readyState !== 'loading')) return;
      } catch (error) {
        // Another navigation tore down the context mid-check; the next lap
        // asks the new document.
        if (!isNavigationRaceError(error)) throw error;
      }
      await sleep(DOM_READY_POLL_MS);
    }
  }

  /**
   * Best-effort wait for in-flight fetch/XHR work to finish so the DOM read
   * next reflects the action's outcome. Returns as soon as the page has been
   * quiet for {@link NETWORK_QUIET_IDLE_MS}, and at the caller's deadline
   * otherwise — a page that never goes quiet degrades to a result, never an
   * error.
   */
  public async awaitNetworkQuiet(overallDeadline: number): Promise<void> {
    const deadline = Math.min(Date.now() + NETWORK_QUIET_TIMEOUT_MS, overallDeadline);
    let quietSince: number | null = null;
    for (;;) {
      const now = Date.now();
      if (this.quietInflight() > NETWORK_QUIET_MAX_INFLIGHT) quietSince = null;
      else quietSince ??= now;
      if (quietSince !== null && now - quietSince >= NETWORK_QUIET_IDLE_MS) return;
      if (now >= deadline) return;
      await sleep(STABILITY_POLL_MS);
    }
  }

  /** Detach the page listeners and drop the in-flight map. */
  public dispose(): void {
    this.detach();
    this.inflight.clear();
  }

  /**
   * Countable in-flight requests right now, dropping any that have aged past
   * {@link INFLIGHT_STALE_MS} — they are streams the page holds open, not the
   * action's outcome. Dropping them from the map (not just the count) is what
   * keeps one long-lived connection from taxing every later call, and bounds
   * the map over a long run.
   */
  private quietInflight(): number {
    const cutoff = Date.now() - INFLIGHT_STALE_MS;
    let count = 0;
    for (const [request, startedAt] of this.inflight) {
      if (startedAt <= cutoff) this.inflight.delete(request);
      else count += 1;
    }
    return count;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
