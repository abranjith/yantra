/** Shared interfaces and types for the browser module. */

/**
 * A Chrome installation as legacy callers see it.
 *
 * `source` distinguishes an externally installed browser from a
 * Yantra-managed one; {@link ResolvedBrowserInstallation} is the semantic
 * source of truth and this is a projection of it.
 */
export interface ChromeInstall {
  readonly path: string;
  readonly version: string;
  readonly majorVersion: number;
  readonly channel: 'stable' | 'beta' | 'dev' | 'canary' | 'chromium' | 'unknown';
  readonly source: 'system' | 'managed';
}

/**
 * A live page serialized for the core page analyzer (FEAT-051). `html` is
 * `document.documentElement.outerHTML`, capped at the HTTP fetcher's body
 * limit; `truncated` is true when the cap cut it.
 */
export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly html: string;
  /** The body's rendered `innerText`. */
  readonly visibleText: string;
  readonly truncated: boolean;
}

/** How a Chrome profile directory is resolved. */
export type ProfileSpec =
  | { readonly kind: 'workflow'; readonly workflowName: string }
  | { readonly kind: 'ephemeral' }
  | { readonly kind: 'explicit'; readonly absolutePath: string };

/** Options passed to BrowserProvider.launch. Validated by Zod before use. */
export interface LaunchOptions {
  readonly profile: ProfileSpec;
  readonly headless: boolean;
  readonly viewport: { readonly width: number; readonly height: number } | null;
  readonly extraArgs: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly startupTimeoutMs: number;
  /** The one semantic browser choice. Null means "resolve from config/auto". */
  readonly browserSelection: BrowserSelection | null;
}

import type { Page as PuppeteerPage } from 'puppeteer-core';

import type { InjectedScriptHost } from '../locator/types.js';

import type { BrowserSelection } from './installation-types.js';

/** Minimal structured logger interface (compatible with pino). */
export interface Logger {
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
  debug(obj: Record<string, unknown> | string, msg?: string): void;
}

/**
 * Minimal Page facade returned from BrowserSession.newPage().
 * Intentionally small surface — FEAT-004 (locator engine) layers on top.
 */
export interface Page {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  /**
   * Run `fn` in the page. At most one serializable argument, because the
   * function is shipped by source and can close over nothing.
   */
  evaluate<T, A = undefined>(fn: (arg: A) => T, arg?: A): Promise<T>;
  close(): Promise<void>;
  url(): string;
  on(event: 'framenavigated', handler: (frame: unknown) => void): void;
  /** Production-only Puppeteer page. Fakes may omit it. */
  readonly puppeteerPage?: PuppeteerPage;
  /** Live locator bridge paired with the Puppeteer page. */
  readonly locatorHost?: InjectedScriptHost;
}

/** Strategy interface for launching Chrome sessions. MVP impl: LocalBrowserProvider. */
export interface BrowserProvider {
  launch(options: Partial<LaunchOptions>): Promise<BrowserSession>;
  detectChrome(): Promise<ChromeInstall | null>;
}

/** Live browser handle returned from BrowserProvider.launch(). */
export interface BrowserSession {
  readonly id: string;
  /** Legacy projection of {@link installation}; both describe the same browser. */
  readonly chrome: ChromeInstall;
  readonly profilePath: string;
  newPage(): Promise<Page>;
  /**
   * Open a page in a fresh, isolated browser context: no cookies, storage, or
   * cache shared with any other page. Closing the returned page closes its
   * context. Used for background page work (FEAT-050's page pool).
   *
   * @throws {BrowserCrashedError} when the session is closed or has crashed.
   */
  newIsolatedPage(): Promise<Page>;
  close(): Promise<void>;
  on(event: BrowserSessionEvent, handler: (...args: unknown[]) => void): void;
}

export type BrowserSessionEvent = 'crashed' | 'disconnected' | 'page-created' | 'page-closed';

/** Result of `yantra doctor`. Never throws — always returns this. */
export interface DoctorReport {
  readonly generatedAt: string;
  readonly cachedFrom: string | null;
  readonly overall: 'ok' | 'warn' | 'error';
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorCheck {
  readonly id:
    | 'browser.selection'
    | 'browser.compatibility'
    | 'browser.managed'
    | 'datadir.writable'
    | 'datadir.permissions'
    | 'cachedir.writable'
    | 'keychain.reachable'
    | 'indexdb.writable';
  readonly status: 'ok' | 'warn' | 'error';
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly fixHint: string | null;
}

/** Abstraction over Chrome profile directory lifecycle. */
export interface ProfileStore {
  resolve(spec: ProfileSpec): Promise<ResolvedProfile>;
  listWorkflowProfiles(): Promise<readonly WorkflowProfileEntry[]>;
  removeWorkflowProfile(workflowName: string): Promise<void>;
  cleanupEphemeral(absolutePath: string): Promise<void>;
}

export interface ResolvedProfile {
  readonly absolutePath: string;
  readonly kind: ProfileSpec['kind'];
  readonly createdNow: boolean;
}

export interface WorkflowProfileEntry {
  readonly workflowName: string;
  readonly absolutePath: string;
  readonly sizeBytes: number;
  readonly lastModified: string;
}
