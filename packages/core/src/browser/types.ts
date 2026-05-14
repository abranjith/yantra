/** Shared interfaces and types for the browser module. */

/** Discovered Chrome installation. */
export interface ChromeInstall {
  readonly path: string;
  readonly version: string;
  readonly majorVersion: number;
  readonly channel: 'stable' | 'beta' | 'dev' | 'canary' | 'chromium' | 'unknown';
  readonly source: 'system';
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
  readonly chromeOverridePath: string | null;
}

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
  evaluate<T>(fn: () => T): Promise<T>;
  close(): Promise<void>;
  url(): string;
  on(event: 'framenavigated', handler: (frame: unknown) => void): void;
}

/** Strategy interface for launching Chrome sessions. MVP impl: LocalBrowserProvider. */
export interface BrowserProvider {
  launch(options: Partial<LaunchOptions>): Promise<BrowserSession>;
  detectChrome(): Promise<ChromeInstall | null>;
}

/** Live browser handle returned from BrowserProvider.launch(). */
export interface BrowserSession {
  readonly id: string;
  readonly chrome: ChromeInstall;
  readonly profilePath: string;
  newPage(): Promise<Page>;
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
    | 'chrome.detected'
    | 'chrome.version_min'
    | 'datadir.writable'
    | 'datadir.permissions'
    | 'cachedir.writable'
    | 'keychain.reachable';
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
