import type { ElementHandle, Page as PuppeteerPage, Target } from 'puppeteer-core';

import { buildAgentPageSnapshot } from '../discovery/observe.js';
import { ReadabilityExtractor, type Extractor } from '../extraction/index.js';

import type { BrowserProvider, BrowserSession, Logger, Page } from './types.js';

const INTERACTABLE_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [role="link"], ' +
  '[role="checkbox"], [role="radio"], [role="combobox"], [role="tab"], [role="menuitem"]';

const DEFAULT_DIGEST_BYTES = 16 * 1024;
const DEFAULT_INTERACTABLE_CAP = 30;
const POPUP_CAPTURE_WAIT_MS = 2_000;

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
}

interface InteractableRecord extends AgentInteractable {
  readonly generation: number;
  readonly handle: ElementHandle<Element>;
}

/** Expected stale-ref failure that directs the agent back to observation. */
export class StaleElementRefError extends Error {
  public readonly code = 'STALE_ELEMENT_REF' as const;
  public constructor(ref: string) {
    super(`Element ref "${ref}" is stale or unknown. Call browser_observe again before acting.`);
    this.name = 'StaleElementRefError';
  }
}

/** Expected hidden/disabled/occluded actionability failure. */
export class BrowserActionabilityError extends Error {
  public constructor(
    public readonly code: 'ELEMENT_HIDDEN' | 'ELEMENT_DISABLED' | 'ELEMENT_OCCLUDED',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserActionabilityError';
  }
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
 * popups are closed and surfaced, and every observation creates a new opaque
 * reference generation.
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
  private generation = 0;
  private nextRef = 1;
  private refs = new Map<string, InteractableRecord>();
  private popupUrls: string[] = [];
  private readonly popupCaptureTasks = new Set<Promise<void>>();
  private readonly popupCaptureByTarget = new WeakMap<Target, Promise<void>>();
  private mutationBindingExposed = false;
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

  /** Navigate the run page and invalidate all prior observation refs. */
  public async navigate(url: string): Promise<BrowserActionResult> {
    await this.ensureLaunched();
    this.invalidateObservation();
    await this.page!.goto(url, { waitUntil: 'domcontentloaded' });
    await this.installMutationObserver();
    return this.currentActionResult();
  }

  /** Observe sanitized page text and mint a fresh opaque ref generation. */
  public async observe(): Promise<AgentBrowserObservation> {
    this.assertLaunched();
    this.invalidateObservation();
    this.generation += 1;
    const snapshot = await buildAgentPageSnapshot(
      this.pageFacade!,
      { extractor: this.extractor },
      {
        maxDigestBytes: this.maxDigestBytes,
        maxInteractables: this.maxInteractables,
      },
    );
    const handles = await this.page!.$$(INTERACTABLE_SELECTOR);
    const interactables: AgentInteractable[] = [];
    for (const raw of snapshot.interactables) {
      const handle = handles[raw.selectorIndex ?? -1];
      if (!handle) continue;
      const ref = `e${this.nextRef++}`;
      const record: InteractableRecord = {
        ref,
        role: raw.role,
        name: raw.name ?? '',
        generation: this.generation,
        handle,
      };
      this.refs.set(ref, record);
      interactables.push({ ref, role: record.role, name: record.name });
    }
    for (const handle of handles) {
      if (![...this.refs.values()].some((record) => record.handle === handle))
        void handle.dispose();
    }
    return { ...snapshot, interactables };
  }

  /** Resolve an opaque ref from the current observation generation. */
  public resolveRef(ref: string): ElementHandle<Element> {
    const record = this.refs.get(ref);
    if (record?.generation !== this.generation) throw new StaleElementRefError(ref);
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
    await assertActionable(handle);
    const page = this.page!;
    const declaresPopup = await handle.evaluate((element) => {
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
    await handle.click();
    const target = await popupTarget;
    if (target) await this.capturePopupTarget(target);
    await settle();
    this.invalidateObservation();
    return this.currentActionResult();
  }

  /** Fill a current ref without returning or logging the supplied value. */
  public async fill(ref: string, value: string): Promise<BrowserActionResult> {
    const handle = this.resolveRef(ref);
    await assertActionable(handle);
    await handle.focus();
    await handle.click({ clickCount: 3 });
    await handle.type(value);
    await settle();
    this.invalidateObservation();
    return this.currentActionResult();
  }

  /** Extract readable page content or the first table as typed rows. */
  public async extract(kind: 'content' | 'table'): Promise<unknown> {
    this.assertLaunched();
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
      if (frame === page.mainFrame()) {
        this.invalidateObservation();
        void this.installMutationObserver();
      }
    });
    page.browser().on('targetcreated', (target) => {
      if (target.opener() !== page.target()) return;
      this.invalidateObservation();
      void this.capturePopupTarget(target);
    });
  }

  private capturePopupTarget(target: Target): Promise<void> {
    const existing = this.popupCaptureByTarget.get(target);
    if (existing) return existing;
    const task = (async () => {
      const popup = await target.page();
      if (!popup) return;
      await settle();
      const url = popup.url() || target.url();
      if (url && url !== 'about:blank') this.popupUrls.push(url);
      await popup.close().catch(() => undefined);
    })();
    this.popupCaptureByTarget.set(target, task);
    this.popupCaptureTasks.add(task);
    void task.finally(() => this.popupCaptureTasks.delete(task));
    return task;
  }

  private async installMutationObserver(): Promise<void> {
    if (!this.page || this.page.isClosed()) return;
    const binding = `__yantraMutation_${this.runId.replace(/[^a-zA-Z0-9]/g, '')}`;
    try {
      if (!this.mutationBindingExposed) {
        await this.page.exposeFunction(binding, () => this.invalidateObservation());
        this.mutationBindingExposed = true;
      }
      await this.page.evaluate((callbackName) => {
        const root = globalThis as typeof globalThis & {
          __yantraObservationObserver?: MutationObserver;
        };
        root.__yantraObservationObserver?.disconnect();
        const callback = (root as unknown as Record<string, () => void>)[callbackName];
        if (typeof callback !== 'function') return;
        const observer = new MutationObserver(() => callback());
        if (document.documentElement)
          observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
          });
        root.__yantraObservationObserver = observer;
      }, binding);
    } catch {
      // Navigation races are harmless; framenavigated installs again.
    }
  }

  private invalidateObservation(): void {
    for (const record of this.refs.values()) void record.handle.dispose();
    this.refs.clear();
  }

  private async currentActionResult(): Promise<BrowserActionResult> {
    await settle();
    await Promise.allSettled([...this.popupCaptureTasks]);
    const popup = this.popupUrls.shift();
    const result = { url: this.page?.url() ?? '', title: await this.page!.title() };
    return popup ? { ...result, popup_intercepted: popup } : result;
  }

  private assertLaunched(): void {
    if (!this.session || !this.pageFacade || !this.page)
      throw new Error('Call browser_navigate before using this browser tool.');
  }

  private async performTeardown(): Promise<void> {
    this.invalidateObservation();
    const session = this.session;
    this.session = null;
    this.page = null;
    this.pageFacade = null;
    if (session) await session.close();
    this.logger?.info({ runId: this.runId }, 'agent browser controller torn down');
  }
}

async function assertActionable(handle: ElementHandle<Element>): Promise<void> {
  const state = await handle.evaluate((element) => {
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
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const receivesEvents = hit === html || (hit !== null && html.contains(hit));
    return { visible, disabled, receivesEvents };
  });
  if (!state.visible)
    throw new BrowserActionabilityError(
      'ELEMENT_HIDDEN',
      'The observed element is no longer visible. Re-observe the page.',
    );
  if (state.disabled)
    throw new BrowserActionabilityError('ELEMENT_DISABLED', 'The observed element is disabled.');
  if (!state.receivesEvents)
    throw new BrowserActionabilityError(
      'ELEMENT_OCCLUDED',
      'Another element intercepts this target. Re-observe or dismiss the overlay.',
    );
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
}
