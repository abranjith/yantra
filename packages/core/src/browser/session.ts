import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { Browser, Page as PuppeteerPage } from 'puppeteer-core';

import { BrowserCrashedError } from './errors.js';
import type {
  BrowserSession,
  BrowserSessionEvent,
  ChromeInstall,
  Logger,
  Page,
  ProfileStore,
  ResolvedProfile,
} from './types.js';

/** Wraps a puppeteer Page into Yantra's minimal Page facade. */
function wrapPage(puppeteerPage: PuppeteerPage, onClose: () => void): Page {
  return {
    goto(url, opts) {
      return puppeteerPage.goto(url, opts as Parameters<PuppeteerPage['goto']>[1]);
    },
    evaluate<T>(fn: () => T) {
      return puppeteerPage.evaluate(fn);
    },
    close() {
      return puppeteerPage.close();
    },
    url() {
      return puppeteerPage.url();
    },
    on(event, handler) {
      if (event === 'framenavigated') {
        puppeteerPage.on('framenavigated', handler);
      }
    },
  };

  void onClose; // referenced in event wiring below — suppresses unused warning
}

type EventHandler = (...args: unknown[]) => void;

/**
 * Live browser session wrapping a puppeteer Browser instance.
 * Handles crash detection, event plumbing, and profile cleanup.
 */
export class LocalBrowserSession implements BrowserSession {
  readonly id: string;
  readonly chrome: ChromeInstall;
  readonly profilePath: string;

  private readonly browser: Browser;
  private readonly child: ChildProcess;
  private readonly profile: ResolvedProfile;
  private readonly profileStore: ProfileStore;
  private readonly logger: Logger;

  private readonly eventHandlers = new Map<BrowserSessionEvent, EventHandler[]>();
  private closed = false;
  private crashed = false;
  private stderrBuffer = '';
  /** Maximum bytes of stderr to buffer for crash diagnostics. */
  private static readonly MAX_STDERR_BYTES = 4096;

  constructor(deps: {
    browser: Browser;
    child: ChildProcess;
    chrome: ChromeInstall;
    profile: ResolvedProfile;
    profileStore: ProfileStore;
    logger: Logger;
  }) {
    this.id = randomUUID();
    this.browser = deps.browser;
    this.child = deps.child;
    this.chrome = deps.chrome;
    this.profile = deps.profile;
    this.profilePath = deps.profile.absolutePath;
    this.profileStore = deps.profileStore;
    this.logger = deps.logger;

    this.installEventWiring();
  }

  private installEventWiring(): void {
    // Buffer stderr for crash diagnostics
    this.child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.stderrBuffer = (this.stderrBuffer + text).slice(-LocalBrowserSession.MAX_STDERR_BYTES);
    });

    // Chrome exited without us calling close()
    this.child.on('exit', (code, signal) => {
      if (this.closed) return; // graceful shutdown — we initiated it
      this.crashed = true;

      const crashErr = new BrowserCrashedError({
        sessionId: this.id,
        exitCode: code,
        signal: signal ?? null,
        lastStderr: this.stderrBuffer,
      });

      this.emit('crashed', crashErr);

      // Best-effort ephemeral cleanup on crash
      if (this.profile.kind === 'ephemeral') {
        void this.profileStore
          .cleanupEphemeral(this.profile.absolutePath)
          .catch((e: unknown) =>
            this.logger.warn({ err: e }, 'Failed to cleanup ephemeral profile after crash'),
          );
      }
    });

    // puppeteer disconnected event (not crash — handled by child exit above)
    this.browser.on('disconnected', () => {
      if (!this.closed) {
        this.emit('disconnected');
      }
    });

    // Page lifecycle events
    this.browser.on('targetcreated', () => {
      this.emit('page-created');
    });
    this.browser.on('targetdestroyed', () => {
      this.emit('page-closed');
    });
  }

  private emit(event: BrowserSessionEvent, ...args: unknown[]): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    for (const handler of handlers) {
      try {
        handler(...args);
      } catch {
        // Event handler errors must not crash the session
      }
    }
  }

  /** @inheritdoc */
  on(event: BrowserSessionEvent, handler: EventHandler): void {
    const existing = this.eventHandlers.get(event) ?? [];
    this.eventHandlers.set(event, [...existing, handler]);
  }

  /**
   * Opens a new browser page and returns a minimal Page facade.
   * @throws {BrowserCrashedError} if the session has already crashed
   */
  async newPage(): Promise<Page> {
    if (this.closed || this.crashed) {
      throw new BrowserCrashedError({
        sessionId: this.id,
        exitCode: null,
        signal: null,
        lastStderr: this.crashed
          ? 'Session has crashed — cannot open new page'
          : 'Session is closed — cannot open new page',
      });
    }

    const puppeteerPage = await this.browser.newPage();
    this.emit('page-created');
    return wrapPage(puppeteerPage, () => this.emit('page-closed'));
  }

  /**
   * Closes the browser session. Idempotent — safe to call multiple times.
   * Cleans up ephemeral profile directories after close.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    try {
      // Give puppeteer 5s to close gracefully
      await Promise.race([
        this.browser.close(),
        new Promise<void>((_, reject) => {
          const t = setTimeout(() => reject(new Error('puppeteer close timeout')), 5000);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
    } catch {
      // Timeout or error — fall back to process kill
      this.killProcess();
    }

    this.logger.info({ sessionId: this.id }, `browser session ${this.id} closed`);

    // Clean up ephemeral profile
    if (this.profile.kind === 'ephemeral') {
      await this.profileStore
        .cleanupEphemeral(this.profile.absolutePath)
        .catch((e: unknown) =>
          this.logger.warn({ err: e }, 'Failed to cleanup ephemeral profile after close'),
        );
    }
  }

  private killProcess(): void {
    try {
      if (process.platform === 'win32') {
        // taskkill ensures child processes are also terminated
        try {
          execFileSync('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], {
            timeout: 3000,
            windowsHide: true,
          });
        } catch {
          this.child.kill();
        }
      } else {
        this.child.kill('SIGTERM');
        // SIGKILL fallback after 2s if still alive
        const timer = setTimeout(() => {
          if (!this.child.killed) this.child.kill('SIGKILL');
        }, 2000);
        if (typeof timer.unref === 'function') timer.unref();
      }
    } catch {
      // Ignore kill errors
    }
  }
}
