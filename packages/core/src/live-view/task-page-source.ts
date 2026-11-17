/**
 * The task page as the live view sees it (FEAT-069 TASK-006).
 *
 * The **task page** is the page a run drives: the agent controller's active
 * page (following its popup policy, so adopting a popup is a target change),
 * or the deterministic executor's single page. FEAT-050 background pool pages
 * are never exposed here, so they are never screencast.
 */

import type { Page as PuppeteerPage } from 'puppeteer-core';

import type { ScreenProtection } from '../browser/screen-protection.js';

/** What changed about the task page. */
export type TaskPageEvent =
  /** A task page now exists (first launch, or a resumed run's fresh page). */
  | { readonly kind: 'page_installed' }
  /** A top-level navigation committed; `epoch` is the new committed-document epoch. */
  | { readonly kind: 'navigation_committed'; readonly epoch: number | null }
  /** The task page was replaced by another target (popup adoption). */
  | { readonly kind: 'target_changed' }
  /** The browser is being torn down; no task page from now on. */
  | { readonly kind: 'torn_down' };

/** The current task page. */
export interface TaskPage {
  readonly page: PuppeteerPage;
  /** False when the run uses a visible window; a headed page is never screencast. */
  readonly headless: boolean;
}

/** The live view's read-only port onto a run's task page. */
export interface TaskPageSource {
  /** The current task page, or null before launch and after teardown. */
  current(): TaskPage | null;
  /** The task page's top-level committed-document epoch, or null when unreadable. */
  topLevelEpoch(): number | null;
  /** Whether the task page might show a secret. */
  readonly screenProtection: ScreenProtection;
  /** Follows task-page changes; returns the unsubscribe function. */
  subscribe(listener: (event: TaskPageEvent) => void): () => void;
}

/**
 * Fans task-page events out to live-view listeners.
 *
 * Owned by the page's owner (controller or replay context), so the owner's
 * own work never depends on a listener: each listener is isolated, and a
 * throwing one is reported through `onListenerError` and does not stop the
 * others or the owner.
 */
export class TaskPageEvents {
  private readonly listeners = new Set<(event: TaskPageEvent) => void>();

  public constructor(private readonly onListenerError: (error: unknown) => void) {}

  public get listenerCount(): number {
    return this.listeners.size;
  }

  public subscribe(listener: (event: TaskPageEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public emit(event: TaskPageEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }
}
