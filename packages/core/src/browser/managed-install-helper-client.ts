import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HelperMessageSchema,
  type HelperRequest,
  type ManagedInstallPhase,
  type ManagedInstallPolicy,
} from './managed-install-types.js';
import { installFailure, ManagedInstallException } from './managed-preflight.js';

export interface ManagedHelperClientDeps {
  readonly helperPath?: () => string;
  readonly helperExists?: (path: string) => boolean;
  readonly spawn?: typeof spawn;
  readonly env?: NodeJS.ProcessEnv;
  readonly killTree?: (child: ChildProcess) => Promise<void>;
}

export type ManagedHelperRunOutcome =
  | { readonly status: 'completed'; readonly buildId: string; readonly executableRelative: string }
  /** Resolve mode's answer. Reaches here through the same deadlines and the same termination. */
  | {
      readonly status: 'availability';
      readonly buildId: string;
      readonly artifactAvailable: boolean;
    }
  | { readonly status: 'cancelled'; readonly at: ManagedInstallPhase };

const ENV_NAMES = [
  'PATH',
  'SystemRoot',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'YANTRA_HOME',
  'YANTRA_DATA_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;
const STDERR_LIMIT = 4_096;

/** Owns helper IPC, deadlines, cancellation, and verified child termination. */
export class ManagedInstallHelperClient {
  private readonly helperPath: () => string;
  private readonly helperExists: (path: string) => boolean;
  private readonly spawnProcess: typeof spawn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly killTree: (child: ChildProcess) => Promise<void>;

  constructor(deps: ManagedHelperClientDeps = {}) {
    this.helperPath =
      deps.helperPath ??
      (() => join(dirname(fileURLToPath(import.meta.url)), 'managed-install-helper.js'));
    this.helperExists = deps.helperExists ?? existsSync;
    this.spawnProcess = deps.spawn ?? spawn;
    this.env = deps.env ?? process.env;
    this.killTree = deps.killTree ?? terminateTree;
  }

  async run(
    request: HelperRequest,
    policy: ManagedInstallPolicy,
    options: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (
        phase: ManagedInstallPhase,
        buildId: string | null,
        downloaded: number,
        total: number | null,
        interruptible: boolean,
      ) => void;
    } = {},
  ): Promise<ManagedHelperRunOutcome> {
    if (options.signal?.aborted === true) return { status: 'cancelled', at: 'preflight' };
    const helper = this.helperPath();
    if (!this.helperExists(helper)) {
      throw new ManagedInstallException(
        installFailure(
          'helper-unavailable',
          'preflight',
          'Build @yantra/core before installing a managed browser.',
          'The compiled managed installation helper is unavailable.',
        ),
      );
    }

    const child = this.spawnProcess(process.execPath, [helper, JSON.stringify(request)], {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: helperEnvironment(this.env),
    });
    let phase: ManagedInstallPhase = 'preflight';
    let buildId: string | null = null;
    let interruptible = true;
    let lastProgress = Date.now();
    let cancelRequested = false;
    let finalResult: Exclude<ManagedHelperRunOutcome, { status: 'cancelled' }> | null = null;
    let finalError: ManagedInstallException | null = null;
    let stderrTail = '';
    let finished = false;

    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-STDERR_LIMIT);
    });

    let resolveOutcome!: (value: ManagedHelperRunOutcome) => void;
    let rejectOutcome!: (reason: ManagedInstallException) => void;
    const outcome = new Promise<ManagedHelperRunOutcome>((resolve, reject) => {
      resolveOutcome = resolve;
      rejectOutcome = reject;
    });
    const settleCancelled = async (): Promise<void> => {
      if (finished) return;
      await this.killTree(child);
      await waitForExit(child, policy.treeExitMs);
      if (finished) return;
      finished = true;
      resolveOutcome({ status: 'cancelled', at: phase });
    };
    const settleTimedOut = async (detail: string): Promise<void> => {
      if (finished) return;
      finalError = new ManagedInstallException(
        installFailure(
          'timed-out',
          phase,
          'Retry the explicit install; interrupted downloads restart from zero.',
          detail,
        ),
      );
      await this.killTree(child);
      await waitForExit(child, policy.treeExitMs).catch(() => undefined);
      if (finished) return;
      finished = true;
      rejectOutcome(finalError);
    };
    const requestCancel = (): void => {
      if (finished || cancelRequested) return;
      cancelRequested = true;
      child.send?.({ kind: 'cancel' });
      const grace = interruptible ? policy.cancelAckMs : policy.finalizeGraceMs;
      const timer = setTimeout(() => void settleCancelled(), grace);
      timer.unref?.();
    };

    child.on('message', (raw: unknown) => {
      const parsed = HelperMessageSchema.safeParse(raw);
      if (!parsed.success) {
        finalError = new ManagedInstallException(
          installFailure(
            'helper-crashed',
            phase,
            'Re-run the installation after rebuilding Yantra.',
            'The install helper sent an invalid IPC message.',
          ),
        );
        void this.killTree(child);
        return;
      }
      const message = parsed.data;
      if (message.kind === 'resolved') {
        buildId = message.buildId;
      } else if (message.kind === 'availability') {
        // Sets `buildId` as well, so the metadata deadline stops arming once the
        // question this run exists to answer has been answered.
        buildId = message.buildId;
        finalResult = {
          status: 'availability',
          buildId: message.buildId,
          artifactAvailable: message.artifactAvailable,
        };
      } else if (message.kind === 'phase') {
        phase = message.phase;
        interruptible = message.interruptible;
        if (phase === 'downloading') lastProgress = Date.now();
        options.onProgress?.(phase, buildId, 0, null, interruptible);
      } else if (message.kind === 'progress') {
        lastProgress = Date.now();
        options.onProgress?.(
          phase,
          buildId,
          message.downloadedBytes,
          message.totalBytes,
          interruptible,
        );
      } else if (message.kind === 'cancel-ack' && cancelRequested) {
        void settleCancelled();
      } else if (message.kind === 'result') {
        finalResult = {
          status: 'completed',
          buildId: message.buildId,
          executableRelative: message.executableRelative,
        };
      } else if (message.kind === 'error') {
        finalError = new ManagedInstallException(
          installFailure(message.code, phase, remediationFor(message.code), message.detail),
        );
      }
    });

    child.once('error', (cause) => {
      finalError = new ManagedInstallException(
        installFailure(
          'helper-crashed',
          phase,
          'Re-run the installation after rebuilding Yantra.',
          `The install helper could not be started: ${cause.message}`,
        ),
      );
    });
    child.once('exit', (code) => {
      if (finished) return;
      finished = true;
      if (cancelRequested) {
        resolveOutcome({ status: 'cancelled', at: phase });
      } else if (finalError !== null) {
        rejectOutcome(finalError);
      } else if (finalResult !== null) {
        resolveOutcome(finalResult);
      } else {
        rejectOutcome(
          new ManagedInstallException(
            installFailure(
              'helper-crashed',
              phase,
              'Re-run the installation.',
              `The install helper exited (${code ?? 'signal'}) without a result.${stderrTail.length === 0 ? '' : ' Diagnostic output was suppressed.'}`,
            ),
          ),
        );
      }
    });

    const wholeTimer = setTimeout(
      () => void settleTimedOut('The whole-operation deadline expired.'),
      policy.wholeOperationMs,
    );
    const metadataTimer = setTimeout(() => {
      if (buildId === null)
        void settleTimedOut('Stable metadata resolution exceeded its deadline.');
    }, policy.metadataMs);
    const stallTimer = setInterval(
      () => {
        if (phase === 'downloading' && Date.now() - lastProgress > policy.stallMs)
          void settleTimedOut('The download stopped making progress.');
      },
      Math.max(25, Math.min(1_000, policy.stallMs)),
    );
    wholeTimer.unref?.();
    metadataTimer.unref?.();
    stallTimer.unref?.();
    options.signal?.addEventListener('abort', requestCancel, { once: true });

    try {
      return await outcome;
    } finally {
      clearTimeout(wholeTimer);
      clearTimeout(metadataTimer);
      clearInterval(stallTimer);
      options.signal?.removeEventListener('abort', requestCancel);
    }
  }
}

export function helperEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_USE_ENV_PROXY: '1' };
  for (const key of ENV_NAMES) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function remediationFor(code: string): string {
  if (code === 'metadata-unavailable')
    return 'Check network access to Chrome for Testing metadata and retry.';
  if (code === 'proxy-failure') return 'Check the configured proxy and retry.';
  if (code === 'extraction-failure')
    return 'Verify the named archive tool works and retry; the download will restart from zero.';
  return 'Check network access and retry; the download will restart from zero.';
}

async function terminateTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const task = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        shell: false,
        windowsHide: true,
      });
      task.once('exit', () => resolve());
      task.once('error', () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The managed install process tree did not exit in time.')),
      timeoutMs,
    );
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
