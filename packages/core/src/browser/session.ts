import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { Browser, Page as PuppeteerPage } from 'puppeteer-core';

import { PuppeteerInjectedScriptHost } from '../locator/injected-host.js';

import { toChromeInstall } from './browser-resolver.js';
import { BrowserCrashedError } from './errors.js';
import type { ResolvedBrowserInstallation } from './installation-types.js';
import type { OwnedBrowserProcess } from './launcher.js';
import type {
  BrowserSession,
  BrowserSessionEvent,
  ChromeInstall,
  Logger,
  Page,
  ProfileStore,
  ResolvedProfile,
} from './types.js';

/**
 * Wrap an arbitrary Puppeteer page in Yantra's minimal facade.
 *
 * Exported for the one caller that acquires a page the session did not hand
 * out: {@link AgentBrowserController} adopting a tab the site opened for
 * itself. Adoption has to leave the run holding the same shape of page it
 * started with — locator bridge included — or every later action silently
 * degrades on the adopted tab.
 */
export function wrapPuppeteerPage(puppeteerPage: PuppeteerPage): Page {
  return wrapPage(puppeteerPage, () => undefined);
}

/** Wraps a puppeteer Page into Yantra's minimal Page facade. */
function wrapPage(puppeteerPage: PuppeteerPage, onClose: () => void): Page {
  const locatorHost = new PuppeteerInjectedScriptHost(puppeteerPage);
  return {
    puppeteerPage,
    locatorHost,
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
 * Live browser session.
 *
 * The session owns exactly what startup handed it: one supervised browser
 * process, one profile, and (for a managed installation) one use reservation.
 * Process supervision is delegated rather than reimplemented, so close and
 * crash paths cannot disagree about what "the browser is gone" means.
 */
export class LocalBrowserSession implements BrowserSession {
  readonly id: string;
  readonly chrome: ChromeInstall;
  readonly installation: ResolvedBrowserInstallation;
  readonly profilePath: string;

  private readonly launched: OwnedBrowserProcess;
  private readonly browser: Browser;
  private readonly child: ChildProcess;
  private readonly profile: ResolvedProfile;
  private readonly profileStore: ProfileStore;
  private readonly logger: Logger;

  private readonly eventHandlers = new Map<BrowserSessionEvent, EventHandler[]>();
  private closed = false;
  private crashed = false;
  private stderrBuffer = '';
  private primaryPageClaimed = false;
  private closing: Promise<void> | null = null;
  /** Maximum bytes of stderr to buffer for crash diagnostics. */
  private static readonly MAX_STDERR_BYTES = 4096;

  constructor(deps: {
    launched: OwnedBrowserProcess;
    installation: ResolvedBrowserInstallation;
    profile: ResolvedProfile;
    profileStore: ProfileStore;
    logger: Logger;
  }) {
    this.id = randomUUID();
    this.launched = deps.launched;
    this.browser = deps.launched.browser;
    this.child = deps.launched.child;
    this.installation = deps.installation;
    // Existing callers still read `chrome`; it projects the resolved identity,
    // which stays the one semantic source of truth.
    this.chrome = toChromeInstall(deps.installation);
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

      // A crash still has to account for the process and the reservation:
      // the child exited, but nothing has released ownership yet.
      void this.launched
        .shutdown()
        .catch((e: unknown) =>
          this.logger.warn({ err: e }, 'Failed to release browser ownership after crash'),
        )
        .then(() => this.cleanupOwnedProfile('crash'));
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

    const existing = typeof this.browser.pages === 'function' ? await this.browser.pages() : [];
    const reusable =
      !this.primaryPageClaimed && existing.length === 1 && existing[0]?.url() === 'about:blank';
    const puppeteerPage = reusable ? existing[0]! : await this.browser.newPage();
    this.primaryPageClaimed = true;
    this.emit('page-created');
    return wrapPage(puppeteerPage, () => this.emit('page-closed'));
  }

  /**
   * Closes the session. Idempotent, and safe under concurrent callers.
   *
   * Process supervision is delegated to the launcher's owned process, which
   * releases the managed reservation only after verified exit. Only an
   * ephemeral profile this session owns is removed — a workflow or explicit
   * profile the user owns is never touched.
   */
  close(): Promise<void> {
    this.closing ??= this.runClose();
    return this.closing;
  }

  private async runClose(): Promise<void> {
    this.closed = true;
    try {
      await this.launched.shutdown();
    } finally {
      this.logger.info({ sessionId: this.id }, `browser session ${this.id} closed`);
      await this.cleanupOwnedProfile('close');
    }
  }

  /** Removes the ephemeral profile this session created, and nothing else. */
  private async cleanupOwnedProfile(phase: 'close' | 'crash'): Promise<void> {
    if (this.profile.kind !== 'ephemeral') return;
    await this.profileStore
      .cleanupEphemeral(this.profile.absolutePath)
      .catch((e: unknown) =>
        this.logger.warn({ err: e }, `Failed to cleanup ephemeral profile after ${phase}`),
      );
  }
}
