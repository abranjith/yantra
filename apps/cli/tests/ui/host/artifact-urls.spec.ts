// @no-llm
/**
 * Signed artifact URLs (FEAT-065 TASK-010): window binding, expiry and MAC
 * integrity. What may be signed and served (the FEAT-066 allowlist gate) is
 * covered by `artifact-serving.spec.ts`.
 */

import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARTIFACT_URL_TTL_MS,
  ArtifactUrls,
  registerArtifactUrls,
} from '../../../src/ui/host/artifact-urls.js';
import { AppHost } from '../../../src/ui/host/host.js';
import { RpcMethodRegistry, type RpcCallContext } from '../../../src/ui/host/rpc-server.js';
import { SessionStore, type SessionGrant } from '../../../src/ui/host/sessions.js';

import { cleanupTempDirs, makeTempDir, makeWebBuild, rawRequest } from './support.js';

const RUN = '20261111T100000Z-research-0000abcd';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let clock: number;
let sessions: SessionStore;
let runsRoot: string;
let urls: ArtifactUrls;
let host: AppHost;
let port: number;
let window: SessionGrant;

async function startHost(hostKey?: Buffer): Promise<void> {
  urls = new ArtifactUrls({
    sessions,
    runsRoot,
    now: () => clock,
    ...(hostKey === undefined ? {} : { hostKey }),
  });
  host = new AppHost({ assetsRoot: makeWebBuild(), routes: [urls.route] });
  ({ port } = await host.start());
}

function fetchSigned(url: string, cookie: string | null = window.cookie) {
  return rawRequest(port, {
    path: url,
    headers: cookie === null ? {} : { cookie: `yantra_session=${cookie}` },
  });
}

beforeEach(async () => {
  clock = Date.parse('2026-11-11T10:00:00.000Z');
  sessions = new SessionStore({ now: () => clock });
  runsRoot = makeTempDir('yantra-runs-');
  const runDir = join(runsRoot, RUN);
  mkdirSync(join(runDir, 'captures'), { recursive: true });
  writeFileSync(join(runDir, 'captures', 'shot.png'), PNG);
  writeFileSync(join(runDir, 'report.md'), '# Report\n');
  writeFileSync(join(runDir, 'lease.json'), '{"run_token":"SECRET-LEASE-TOKEN"}');
  window = sessions.exchange(sessions.issueLaunchCode().code)!;
  sessions.socketOpened(window.windowId);
  await startHost();
});

afterEach(async () => {
  await host.stop();
  cleanupTempDirs();
});

describe('a valid URL', () => {
  it('serves the image with nosniff and no-store, inline', async () => {
    // Arrange
    const { url } = await urls.sign(window.windowId, RUN, 'captures/shot.png');

    // Act
    const response = await fetchSigned(url);

    // Assert
    expect(response.status).toBe(200);
    expect(response.body.equals(PNG)).toBe(true);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-disposition']).toBeUndefined();
  });

  it('expires after five minutes', async () => {
    expect((await urls.sign(window.windowId, RUN, 'report.md')).expiresAt).toBe(
      clock + ARTIFACT_URL_TTL_MS,
    );
  });

  it('answers HEAD with the headers and no body', async () => {
    const { url } = await urls.sign(window.windowId, RUN, 'report.md');
    const response = await rawRequest(port, {
      method: 'HEAD',
      path: url,
      headers: { cookie: `yantra_session=${window.cookie}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers['content-length']).toBe('9');
    expect(response.body.length).toBe(0);
  });
});

describe('binding', () => {
  it("fails with window B's cookie for a URL signed for window A", async () => {
    const other = sessions.exchange(sessions.issueLaunchCode().code)!;
    sessions.socketOpened(other.windowId);
    const { url } = await urls.sign(window.windowId, RUN, 'report.md');
    expect((await fetchSigned(url, other.cookie)).status).toBe(404);
  });

  it('fails without a cookie', async () => {
    const { url } = await urls.sign(window.windowId, RUN, 'report.md');
    expect((await fetchSigned(url, null)).status).toBe(404);
  });

  it('fails one millisecond after expiry', async () => {
    const { url } = await urls.sign(window.windowId, RUN, 'report.md');
    clock += ARTIFACT_URL_TTL_MS;
    expect((await fetchSigned(url)).status).toBe(200);
    clock += 1;
    expect((await fetchSigned(url)).status).toBe(404);
  });

  it('dies with its window', async () => {
    const { url } = await urls.sign(window.windowId, RUN, 'report.md');
    sessions.revoke(window.windowId);
    expect((await fetchSigned(url)).status).toBe(404);
  });

  it('refuses to sign for a window whose session ended', async () => {
    sessions.revoke(window.windowId);
    await expect(urls.sign(window.windowId, RUN, 'report.md')).rejects.toMatchObject({
      data: { code: 'unauthorized' },
    });
  });

  it('dies when the window resumes with a new capability', async () => {
    const { url } = await urls.sign(window.windowId, RUN, 'report.md');
    const resumed = sessions.exchange(
      sessions.issueResumeCode(window.windowId)!.code,
      window.cookie,
    )!;
    expect((await fetchSigned(url, resumed.cookie)).status).toBe(404);
  });

  it('fails under a new host key (a host restart)', async () => {
    const { url } = await urls.sign(window.windowId, RUN, 'report.md');
    await host.stop();
    await startHost();
    expect((await fetchSigned(url)).status).toBe(404);
  });

  it('uses a different key for each host start', async () => {
    const a = new ArtifactUrls({ sessions, runsRoot, now: () => clock });
    const b = new ArtifactUrls({ sessions, runsRoot, now: () => clock });
    const signedA = (await a.sign(window.windowId, RUN, 'report.md')).url;
    const signedB = (await b.sign(window.windowId, RUN, 'report.md')).url;
    expect(signedA).not.toBe(signedB);
  });
});

describe('integrity', () => {
  function flip(text: string, index: number): string {
    const replacement = text[index] === 'A' ? 'B' : 'A';
    return `${text.slice(0, index)}${replacement}${text.slice(index + 1)}`;
  }

  it('fails when one byte of the payload changes', async () => {
    const { url } = await urls.sign(window.windowId, RUN, 'report.md');
    expect((await fetchSigned(flip(url, 5))).status).toBe(404);
  });

  it('fails when one byte of the MAC changes', async () => {
    const { url } = await urls.sign(window.windowId, RUN, 'report.md');
    expect((await fetchSigned(flip(url, url.length - 3))).status).toBe(404);
  });

  it('fails a forged payload re-pointed at another file', async () => {
    const { url } = await urls.sign(window.windowId, RUN, 'report.md');
    const [payload, mac] = url.slice(3).split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const forged = Buffer.from(JSON.stringify({ ...decoded, p: 'lease.json' })).toString(
      'base64url',
    );
    expect((await fetchSigned(`/a/${forged}.${mac}`)).status).toBe(404);
  });

  it('never serves lease.json, even for a correctly signed token', async () => {
    // Arrange: a host whose key the test knows, and a token signed exactly as
    // sign() would, for a path sign() itself refuses.
    const key = Buffer.alloc(32, 7);
    await host.stop();
    await startHost(key);
    const live = sessions.liveWindow(window.windowId)!;
    const payload = Buffer.from(
      JSON.stringify({ r: RUN, p: 'lease.json', w: window.windowId, e: clock + 60_000 }),
    ).toString('base64url');
    const mac = createHmac('sha256', key)
      .update(window.windowId, 'utf8')
      .update(live.capabilityHash)
      .update(payload, 'utf8')
      .digest('base64url');
    expect(urls.verify(`${payload}.${mac}`, window.cookie)).not.toBeNull();

    // Act
    const response = await fetchSigned(`/a/${payload}.${mac}`);

    // Assert
    expect(response.status).toBe(404);
    expect(response.body.toString()).not.toContain('SECRET-LEASE-TOKEN');
    expect(urls.denialsByReason.not_public).toBe(1);
  });

  it.each(['/a/', '/a/nodot', '/a/a.b.c', '/a/%%%.x'])('answers 404 for %s', async (path) => {
    expect((await fetchSigned(path)).status).toBe(404);
  });

  it('answers byte-identical 404s and counts them', async () => {
    const before = urls.denialCount;
    const a = await fetchSigned('/a/x.y');
    const b = await fetchSigned('/a/nodot');
    expect(a.body.equals(b.body)).toBe(true);
    expect(urls.denialCount).toBe(before + 2);
    expect(urls.denialsByReason.signature).toBe(2);
  });

  it('refuses methods other than GET and HEAD', async () => {
    const { url } = await urls.sign(window.windowId, RUN, 'report.md');
    const response = await rawRequest(port, {
      method: 'DELETE',
      path: url,
      headers: {
        cookie: `yantra_session=${window.cookie}`,
        origin: `http://127.0.0.1:${port}`,
      },
    });
    expect(response.status).toBe(404);
  });
});

describe('artifact.url', () => {
  it('signs for the calling window', async () => {
    const methods = new RpcMethodRegistry();
    registerArtifactUrls(methods, urls);
    const result = (await methods.get('artifact.url')!.handler({ run_id: RUN, path: 'report.md' }, {
      windowId: window.windowId,
      connection: {},
    } as unknown as RpcCallContext)) as { url: string };
    expect((await fetchSigned(result.url)).status).toBe(200);
  });
});
