import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ManagedInstallHelperClient,
  helperEnvironment,
} from '../../src/browser/managed-install-helper-client.js';
import {
  DEFAULT_MANAGED_INSTALL_POLICY,
  type HelperRequest,
  type ManagedInstallPolicy,
} from '../../src/browser/managed-install-types.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-install-helper.mjs',
);
const SPAWNING_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'spawning-helper.mjs',
);
const PROXY_REQUEST_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'proxy-request-helper.mjs',
);
const roots: string[] = [];
const descendantPids: number[] = [];
const servers: Server[] = [];

function request(operationId: string, cacheDir: string): HelperRequest {
  return {
    protocolVersion: 2,
    mode: 'install',
    operationId,
    browser: 'chrome',
    platform:
      process.platform === 'win32' ? 'win64' : process.platform === 'darwin' ? 'mac' : 'linux',
    cacheDir,
    buildId: null,
    progressIntervalMs: 10,
  };
}

function policy(overrides: Partial<ManagedInstallPolicy> = {}): ManagedInstallPolicy {
  return {
    ...DEFAULT_MANAGED_INSTALL_POLICY,
    wholeOperationMs: 2_000,
    metadataMs: 500,
    stallMs: 100,
    cancelAckMs: 100,
    finalizeGraceMs: 1_000,
    treeExitMs: 1_000,
    ...overrides,
  };
}

describe('@no-llm managed install helper client', () => {
  afterEach(async () => {
    for (const pid of descendantPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The expected path: the helper client already terminated the tree.
      }
    }
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('runs the complete validated helper sequence and emits bounded progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-helper-'));
    roots.push(root);
    const progress: string[] = [];
    const outcome = await new ManagedInstallHelperClient({ helperPath: () => FIXTURE }).run(
      request('happy', root),
      policy(),
      { onProgress: (phase) => progress.push(phase) },
    );
    expect(outcome).toEqual({
      status: 'completed',
      buildId: '153.0.8010.36',
      executableRelative: 'chrome/linux/chrome',
    });
    expect(progress).toContain('downloading');
  });

  it('fails typed when the helper emits malformed IPC', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-helper-'));
    roots.push(root);
    await expect(
      new ManagedInstallHelperClient({ helperPath: () => FIXTURE }).run(
        request('malformed', root),
        policy(),
      ),
    ).rejects.toMatchObject({ context: { code: 'helper-crashed' } });
  });

  it('classifies a clean exit without a result as a helper crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-helper-'));
    roots.push(root);
    await expect(
      new ManagedInstallHelperClient({ helperPath: () => FIXTURE }).run(
        request('exit-zero', root),
        policy(),
      ),
    ).rejects.toMatchObject({ context: { code: 'helper-crashed' } });
  });

  it.each(['resolving-stable', 'downloading', 'extracting'] as const)(
    'cancels during %s and observes actual helper exit',
    async (phase) => {
      const root = await mkdtemp(join(tmpdir(), 'yantra-helper-'));
      roots.push(root);
      const abort = new AbortController();
      const run = new ManagedInstallHelperClient({ helperPath: () => FIXTURE }).run(
        request(`cancel-${phase}`, root),
        policy(),
        {
          signal: abort.signal,
          onProgress: (seen) => {
            if (seen === phase) abort.abort();
          },
        },
      );
      await expect(run).resolves.toEqual({ status: 'cancelled', at: phase });
    },
  );

  it('waits through a non-interruptible finalizing window before acknowledging cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-helper-'));
    roots.push(root);
    const abort = new AbortController();
    const started = Date.now();
    const run = new ManagedInstallHelperClient({ helperPath: () => FIXTURE }).run(
      request('block-finalize', root),
      policy(),
      {
        signal: abort.signal,
        onProgress: (phase) => {
          if (phase === 'finalizing') abort.abort();
        },
      },
    );
    await expect(run).resolves.toEqual({ status: 'cancelled', at: 'finalizing' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  it('terminates a real extraction descendant before reporting cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-helper-tree-'));
    roots.push(root);
    const abort = new AbortController();
    const run = new ManagedInstallHelperClient({ helperPath: () => SPAWNING_FIXTURE }).run(
      request('spawn-descendant', root),
      policy(),
      {
        signal: abort.signal,
        onProgress: (phase) => {
          if (phase === 'extracting') abort.abort();
        },
      },
    );

    await expect(run).resolves.toEqual({ status: 'cancelled', at: 'extracting' });
    const descendantPid = Number(await readFile(join(root, 'descendant.pid'), 'utf8'));
    descendantPids.push(descendantPid);
    await expect
      .poll(
        () => {
          try {
            process.kill(descendantPid, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 1_000 },
      )
      .toBe(false);
  });

  it('classifies a stalled transfer before the whole-operation deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-helper-'));
    roots.push(root);
    const started = Date.now();
    await expect(
      new ManagedInstallHelperClient({ helperPath: () => FIXTURE }).run(
        request('stall', root),
        policy(),
      ),
    ).rejects.toMatchObject({
      context: { code: 'timed-out', detail: expect.stringContaining('stopped making progress') },
    });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('uses an explicit environment allowlist and strips download overrides and secrets', () => {
    const env = helperEnvironment({
      PATH: '/bin',
      HTTPS_PROXY: 'http://proxy',
      SECRET: 'do-not-pass',
      PUPPETEER_DOWNLOAD_BASE_URL: 'https://mirror',
    });
    expect(env).toMatchObject({
      PATH: '/bin',
      HTTPS_PROXY: 'http://proxy',
      NODE_USE_ENV_PROXY: '1',
    });
    expect(env.SECRET).toBeUndefined();
    expect(env.PUPPETEER_DOWNLOAD_BASE_URL).toBeUndefined();
  });

  it('routes helper HTTPS traffic through the configured proxy instead of bypassing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-helper-proxy-'));
    roots.push(root);
    let contacts = 0;
    const proxy = createServer((_request, response) => {
      contacts += 1;
      response.writeHead(502).end();
    });
    proxy.on('connect', (_request, socket) => {
      contacts += 1;
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    servers.push(proxy);
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (address === null || typeof address === 'string') throw new Error('Proxy did not bind.');

    await expect(
      new ManagedInstallHelperClient({
        helperPath: () => PROXY_REQUEST_FIXTURE,
        env: { HTTPS_PROXY: `http://127.0.0.1:${address.port}` },
      }).run(request('proxy-request', root), policy()),
    ).rejects.toMatchObject({ context: { code: 'metadata-unavailable' } });
    expect(contacts).toBeGreaterThan(0);
  });

  it('reports a missing compiled helper with an actionable build instruction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-helper-'));
    roots.push(root);
    await expect(
      new ManagedInstallHelperClient({ helperPath: () => join(root, 'missing.js') }).run(
        request('happy', root),
        policy(),
      ),
    ).rejects.toMatchObject({
      context: {
        code: 'helper-unavailable',
        remediation: expect.stringContaining('Build @yantra/core'),
      },
    });
  });
});
