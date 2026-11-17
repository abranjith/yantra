/**
 * The deterministic executor's task page (FEAT-069 TASK-006).
 *
 * A `run` / `resume` workflow drives one page (`ctx.page`), attached lazily
 * before the first step. This adapter is the replay context's
 * {@link TaskPageSource}: the executor attaches each page it creates (a resumed
 * run gets a fresh one), the page's settler reports navigation commits through
 * a second listener that leaves its own bookkeeping alone, and the orchestrator
 * tears it down before closing the browser.
 */

import type { Page as PuppeteerPage } from 'puppeteer-core';

import type { PageSettler } from '../browser/page-settle.js';
import type { ScreenProtection } from '../browser/screen-protection.js';

import {
  TaskPageEvents,
  type TaskPage,
  type TaskPageEvent,
  type TaskPageSource,
} from './task-page-source.js';

export interface ReplayTaskPageOptions {
  /** Replay launches headless today; a headed page is never screencast. */
  readonly headless: boolean;
  /** Receives an error thrown by a live-view listener; the run is unaffected. */
  readonly onListenerError: (error: unknown) => void;
}

export class ReplayTaskPage implements TaskPageSource {
  private page: PuppeteerPage | null = null;
  private settler: PageSettler | null = null;
  private detachSettler: (() => void) | null = null;
  private readonly events: TaskPageEvents;

  public constructor(
    public readonly screenProtection: ScreenProtection,
    private readonly options: ReplayTaskPageOptions,
  ) {
    this.events = new TaskPageEvents(options.onListenerError);
  }

  public current(): TaskPage | null {
    return this.page === null ? null : { page: this.page, headless: this.options.headless };
  }

  public topLevelEpoch(): number | null {
    return this.settler?.epoch ?? null;
  }

  public subscribe(listener: (event: TaskPageEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  /**
   * Records the executor's page and its settler. Attaching the same page
   * again only (re)binds a settler that arrived later; a different page is
   * announced as a new task page.
   */
  public attach(page: PuppeteerPage, settler: PageSettler | null): void {
    const samePage = this.page === page;
    if (samePage && this.settler === settler) return;
    this.detachSettler?.();
    this.detachSettler = null;
    const replaced = this.page !== null && !samePage;
    this.page = page;
    this.settler = settler;
    if (settler !== null) {
      this.detachSettler = settler.addNavigationListener(() => {
        this.events.emit({ kind: 'navigation_committed', epoch: settler.epoch });
      });
    }
    if (samePage) return;
    this.events.emit(replaced ? { kind: 'target_changed' } : { kind: 'page_installed' });
  }

  /** The browser is closing: no task page from now on. Idempotent. */
  public tearDown(): void {
    if (this.page === null) return;
    this.detachSettler?.();
    this.detachSettler = null;
    this.page = null;
    this.settler = null;
    this.events.emit({ kind: 'torn_down' });
  }
}
