/**
 * Browser process supervision.
 *
 * The guarantee this module exists to provide is narrow and load-bearing:
 * *nothing downstream may treat a browser as gone until its process has
 * verifiably exited*. A signal sent is a request, a Puppeteer disconnect is a
 * transport event, and `child.killed` only records that a signal was
 * dispatched — none of the three is an exit. Only the child's `exit` event is.
 */

import { execFile, type ChildProcess } from 'node:child_process';

import { BrowserProcessError } from './errors.js';

/** Default grace before escalating from "please close" to "terminate". */
export const DEFAULT_GRACEFUL_CLOSE_MS = 5_000;
/** Default wait for the process tree to actually disappear after termination. */
export const DEFAULT_TERMINATION_MS = 5_000;

export interface ProcessTreeTerminator {
  /** Terminates the process and its descendants. Best effort; never throws. */
  terminate(pid: number): Promise<void>;
}

/**
 * Real terminator.
 *
 * On Windows `taskkill /T /F` is the only reliable way to take the whole Chrome
 * tree, and it is spawned with `windowsHide` so Yantra's own housekeeping never
 * flashes a console window at the user.
 */
export class NodeProcessTreeTerminator implements ProcessTreeTerminator {
  private readonly platform: NodeJS.Platform;
  private readonly hardKillDelayMs: number;

  constructor(
    deps: { readonly platform?: NodeJS.Platform; readonly hardKillDelayMs?: number } = {},
  ) {
    this.platform = deps.platform ?? process.platform;
    this.hardKillDelayMs = deps.hardKillDelayMs ?? 2_000;
  }

  /** @inheritdoc */
  async terminate(pid: number): Promise<void> {
    if (this.platform === 'win32') {
      await new Promise<void>((resolve) => {
        execFile(
          'taskkill',
          ['/pid', String(pid), '/T', '/F'],
          { timeout: 5_000, windowsHide: true },
          () => resolve(),
        );
      });
      return;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return; // Already gone.
    }
    await new Promise((resolve) => setTimeout(resolve, this.hardKillDelayMs).unref?.());
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Exited during the grace window — the desired outcome.
    }
  }
}

export interface SupervisorDeps {
  readonly terminator?: ProcessTreeTerminator;
  readonly gracefulCloseMs?: number;
  readonly terminationMs?: number;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

/**
 * Owns one browser child process from spawn to verified exit.
 *
 * Every timer and listener it installs is removed when it settles, so an
 * abandoned supervisor cannot keep the event loop alive or fire into a closed
 * session.
 */
export class BrowserProcessSupervisor {
  readonly child: ChildProcess;

  private readonly terminator: ProcessTreeTerminator;
  private readonly gracefulCloseMs: number;
  private readonly terminationMs: number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  private exited = false;
  private exitInfo: { readonly code: number | null; readonly signal: string | null } | null = null;
  private readonly exitPromise: Promise<void>;
  private shutdownPromise: Promise<void> | null = null;

  constructor(child: ChildProcess, deps: SupervisorDeps = {}) {
    this.child = child;
    this.terminator = deps.terminator ?? new NodeProcessTreeTerminator();
    this.gracefulCloseMs = deps.gracefulCloseMs ?? DEFAULT_GRACEFUL_CLOSE_MS;
    this.terminationMs = deps.terminationMs ?? DEFAULT_TERMINATION_MS;
    this.setTimer = deps.setTimeout ?? setTimeout;
    this.clearTimer = deps.clearTimeout ?? clearTimeout;

    this.exitPromise = new Promise<void>((resolve) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        this.exited = true;
        this.exitInfo = { code, signal: signal ?? null };
        resolve();
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        onExit(child.exitCode, child.signalCode);
        return;
      }
      child.once('exit', onExit);
    });
  }

  /** True only once the `exit` event has fired — never a `killed` flag. */
  hasExited(): boolean {
    return this.exited;
  }

  get exitStatus(): { readonly code: number | null; readonly signal: string | null } | null {
    return this.exitInfo;
  }

  /** Resolves when the process has verifiably exited. */
  whenExited(): Promise<void> {
    return this.exitPromise;
  }

  /**
   * Closes the browser, escalating on a bounded schedule, and returns only once
   * the process has exited.
   *
   * Concurrent and repeated calls share one shutdown: a second caller waits for
   * the first rather than issuing a second round of signals.
   *
   * @param graceful - The polite close (usually `browser.close()`).
   * @throws {BrowserProcessError} when the process cannot be proved to have exited.
   */
  shutdown(graceful?: () => Promise<unknown>): Promise<void> {
    this.shutdownPromise ??= this.runShutdown(graceful);
    return this.shutdownPromise;
  }

  private async runShutdown(graceful?: () => Promise<unknown>): Promise<void> {
    if (this.exited) return;

    if (graceful !== undefined) {
      await this.withDeadline(
        (async () => {
          try {
            await graceful();
          } catch {
            // A failed polite close is not fatal; escalation follows.
          }
          await this.exitPromise;
        })(),
        this.gracefulCloseMs,
      );
    }
    if (this.exited) return;

    const pid = this.child.pid;
    if (pid === undefined) {
      throw new BrowserProcessError({
        phase: 'close',
        detail: 'the browser process handle has no pid, so its exit cannot be verified',
        exitProven: false,
      });
    }

    await this.terminator.terminate(pid);
    await this.withDeadline(this.exitPromise, this.terminationMs);

    if (!this.exited) {
      throw new BrowserProcessError({
        phase: 'close',
        detail: `the browser process tree (pid ${pid}) did not exit within ${this.terminationMs}ms`,
        exitProven: false,
      });
    }
  }

  /** Races a promise against a deadline, always clearing the timer it installs. */
  private async withDeadline(work: Promise<unknown>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = this.setTimer(resolve, ms);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) this.clearTimer(timer);
    }
  }
}
