/** Isolated programmatic @puppeteer/browsers acquisition boundary. */
import { relative, resolve } from 'node:path';

import { Browser, install, resolveBuildId } from '@puppeteer/browsers';

import {
  HelperRequestSchema,
  ParentMessageSchema,
  type HelperMessage,
} from './managed-install-types.js';
import { isContainedIn } from './managed-state.js';
import { managedBrowsersRoot } from './paths.js';

function send(message: HelperMessage, after?: () => void): void {
  if (typeof process.send !== 'function') {
    after?.();
    return;
  }
  process.send(message, () => after?.());
}

function finish(message: HelperMessage, exitCode: number): void {
  send(message, () => {
    process.exitCode = exitCode;
    process.disconnect?.();
  });
}

function sanitize(detail: string): string {
  return detail.replace(/([a-z]+:\/\/)[^/@\s]+@/giu, '$1').slice(0, 1_024);
}

async function main(): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(process.argv[2] ?? 'null');
  } catch {
    finish(
      { kind: 'error', code: 'helper-crashed', detail: 'Invalid managed install helper JSON.' },
      2,
    );
    return;
  }
  const parsed = HelperRequestSchema.safeParse(raw);
  if (!parsed.success) {
    finish(
      { kind: 'error', code: 'helper-crashed', detail: 'Invalid managed install helper request.' },
      2,
    );
    return;
  }
  const request = parsed.data;
  const root = managedBrowsersRoot();
  const childName = relative(root, resolve(request.cacheDir));
  if (
    !(await isContainedIn(request.cacheDir, root)) ||
    !/^installation-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(childName)
  ) {
    finish(
      {
        kind: 'error',
        code: 'helper-crashed',
        detail: 'Candidate cache directory is outside the managed browser root.',
      },
      2,
    );
    return;
  }

  let cancelled = false;
  process.on('message', (message: unknown) => {
    if (ParentMessageSchema.safeParse(message).success) {
      cancelled = true;
      send({ kind: 'cancel-ack' });
    }
  });
  send({
    kind: 'ready',
    protocolVersion: 1,
    nodeVersion: process.versions.node,
    envProxyRequested: process.env.NODE_USE_ENV_PROXY === '1',
  });

  let phase: 'resolving-stable' | 'downloading' | 'extracting' | 'finalizing' = 'resolving-stable';
  try {
    send({ kind: 'phase', phase, interruptible: true });
    const buildId =
      request.buildId ??
      (await resolveBuildId(Browser.CHROME, request.platform as never, 'stable'));
    if (cancelled) {
      process.disconnect?.();
      return;
    }
    send({ kind: 'resolved', buildId });
    phase = 'downloading';
    send({ kind: 'phase', phase, interruptible: true });
    let lastProgressAt = 0;
    let postDownloadPhaseSent = false;
    const installed = await install({
      browser: Browser.CHROME,
      buildId,
      cacheDir: request.cacheDir,
      platform: request.platform as never,
      installDeps: false,
      downloadProgressCallback: (downloadedBytes, totalBytes) => {
        const now = Date.now();
        if (now - lastProgressAt >= request.progressIntervalMs || downloadedBytes >= totalBytes) {
          lastProgressAt = now;
          send({ kind: 'progress', downloadedBytes, totalBytes });
        }
        if (!postDownloadPhaseSent && totalBytes > 0 && downloadedBytes >= totalBytes) {
          postDownloadPhaseSent = true;
          phase =
            request.platform === 'win32' || request.platform === 'win64'
              ? 'finalizing'
              : 'extracting';
          send({ kind: 'phase', phase, interruptible: phase !== 'finalizing' });
        }
      },
    });
    if (cancelled) {
      process.disconnect?.();
      return;
    }
    finish(
      {
        kind: 'result',
        buildId,
        executableRelative: relative(request.cacheDir, installed.executablePath),
      },
      0,
    );
  } catch (cause) {
    const detail = sanitize(cause instanceof Error ? cause.message : String(cause));
    const proxyConfigured = Boolean(
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy,
    );
    const failurePhase: string = phase;
    const code =
      failurePhase === 'resolving-stable'
        ? 'metadata-unavailable'
        : failurePhase === 'extracting' || failurePhase === 'finalizing'
          ? 'extraction-failure'
          : proxyConfigured
            ? 'proxy-failure'
            : 'network-failure';
    finish({ kind: 'error', code, detail }, 1);
  }
}

void main();
