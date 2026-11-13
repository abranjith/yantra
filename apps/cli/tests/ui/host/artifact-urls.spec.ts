// @no-llm
/**
 * Signed artifact URLs (FEAT-065 TASK-010): window binding, expiry, MAC
 * integrity, the denylist, the public allowlist and path containment.
 */

import { createHmac } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARTIFACT_URL_TTL_MS,
  ArtifactUrls,
  DEFAULT_ARTIFACT_POLICY,
  isDenied,
  normalizeArtifactPath,
  registerArtifactUrls,
  type ArtifactPolicy,
} from '../../../src/ui/host/artifact-urls.js';
import { AppHost } from '../../../src/ui/host/host.js';
import {
  RpcError,
  RpcMethodRegistry,
  type RpcCallContext,
} from '../../../src/ui/host/rpc-server.js';
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

async function startHost(policy?: ArtifactPolicy, hostKey?: Buffer): Promise<void> {
  urls = new ArtifactUrls({
    sessions,
    runsRoot,
    now: () => clock,
    ...(policy === undefined ? {} : { policy }),
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
  mkdirSync(join(runDir, 'captures', 'step-1'), { recursive: true });
  writeFileSync(join(runDir, 'captures', 'step-1', 'shot.png'), PNG);
  writeFileSync(join(runDir, 'report.md'), '# Report\n');
  writeFileSync(join(runDir, 'page.html'), '<script>alert(1)</script>');
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
  it('serves the image with nosniff and no-store', async () => {
    // Arrange
    const { url } = urls.sign(window.windowId, RUN, 'captures/step-1/shot.png');

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

  it('serves report.md as an attachment', async () => {
    const { url } = urls.sign(window.windowId, RUN, 'report.md');
    const response = await fetchSigned(url);
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="report.md"');
  });

  it('expires after five minutes', () => {
    expect(urls.sign(window.windowId, RUN, 'report.md').expiresAt).toBe(
      clock + ARTIFACT_URL_TTL_MS,
    );
  });
});

describe('binding', () => {
  it("fails with window B's cookie for a URL signed for window A", async () => {
    const other = sessions.exchange(sessions.issueLaunchCode().code)!;
    sessions.socketOpened(other.windowId);
    const { url } = urls.sign(window.windowId, RUN, 'report.md');
    expect((await fetchSigned(url, other.cookie)).status).toBe(404);
  });

  it('fails without a cookie', async () => {
    const { url } = urls.sign(window.windowId, RUN, 'report.md');
    expect((await fetchSigned(url, null)).status).toBe(404);
  });

  it('fails one millisecond after expiry', async () => {
    const { url } = urls.sign(window.windowId, RUN, 'report.md');
    clock += ARTIFACT_URL_TTL_MS;
    expect((await fetchSigned(url)).status).toBe(200);
    clock += 1;
    expect((await fetchSigned(url)).status).toBe(404);
  });

  it('dies with its window', async () => {
    const { url } = urls.sign(window.windowId, RUN, 'report.md');
    sessions.revoke(window.windowId);
    expect((await fetchSigned(url)).status).toBe(404);
  });

  it('dies when the window resumes with a new capability', async () => {
    const { url } = urls.sign(window.windowId, RUN, 'report.md');
    const resumed = sessions.exchange(
      sessions.issueResumeCode(window.windowId)!.code,
      window.cookie,
    )!;
    expect((await fetchSigned(url, resumed.cookie)).status).toBe(404);
  });

  it('fails under a new host key (a host restart)', async () => {
    const { url } = urls.sign(window.windowId, RUN, 'report.md');
    await host.stop();
    await startHost();
    expect((await fetchSigned(url)).status).toBe(404);
  });

  it('uses a different key for each host start', () => {
    const a = new ArtifactUrls({ sessions, runsRoot, now: () => clock });
    const b = new ArtifactUrls({ sessions, runsRoot, now: () => clock });
    const signedA = a.sign(window.windowId, RUN, 'report.md').url;
    const signedB = b.sign(window.windowId, RUN, 'report.md').url;
    expect(signedA).not.toBe(signedB);
  });
});

describe('integrity', () => {
  function flip(text: string, index: number): string {
    const replacement = text[index] === 'A' ? 'B' : 'A';
    return `${text.slice(0, index)}${replacement}${text.slice(index + 1)}`;
  }

  it('fails when one byte of the payload changes', async () => {
    const { url } = urls.sign(window.windowId, RUN, 'report.md');
    expect((await fetchSigned(flip(url, 5))).status).toBe(404);
  });

  it('fails when one byte of the MAC changes', async () => {
    const { url } = urls.sign(window.windowId, RUN, 'report.md');
    expect((await fetchSigned(flip(url, url.length - 3))).status).toBe(404);
  });

  it('fails a forged payload re-pointed at another file', async () => {
    const { url } = urls.sign(window.windowId, RUN, 'report.md');
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

  it.each(['/a/', '/a/nodot', '/a/a.b.c', '/a/%%%.x'])('answers 404 for %s', async (path) => {
    expect((await fetchSigned(path)).status).toBe(404);
  });

  it('answers byte-identical 404s and counts them', async () => {
    const before = urls.denialCount;
    const a = await fetchSigned('/a/x.y');
    const b = await fetchSigned('/a/nodot');
    expect(a.body.equals(b.body)).toBe(true);
    expect(urls.denialCount).toBe(before + 2);
  });
});

describe('what may be signed and served', () => {
  const allowAll: ArtifactPolicy = { isPublic: () => true };

  it.each(['manifest.json', 'events.jsonl', 'page.html'])(
    'refuses to sign %s under the default policy',
    (path) => {
      const error = (() => {
        try {
          urls.sign(window.windowId, RUN, path);
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(-32003);
    },
  );

  it.each([
    'lease.json',
    'reconcile.lock',
    'decisions/abc.json',
    'state.json.1234.abcd.tmp',
    'run.sock',
    'host.lock',
    'invocations/x.json',
    'profiles/Default/Cookies',
    'chrome-profile/Local State',
  ])('refuses %s even when the allowlist wrongly includes it (the denylist wins)', async (path) => {
    // Arrange: a policy that allows everything.
    await host.stop();
    await startHost(allowAll);

    // Act / Assert
    expect(() => urls.sign(window.windowId, RUN, path)).toThrow(RpcError);
    expect(isDenied(path)).toBe(true);
  });

  it('never serves lease.json, even for a correctly signed token', async () => {
    // Arrange: an allow-all host whose key the test knows, and a token signed
    // exactly as sign() would, for a path sign() itself refuses.
    const key = Buffer.alloc(32, 7);
    await host.stop();
    await startHost(allowAll, key);
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
  });

  it('serves an HTML file only as an attachment', async () => {
    await host.stop();
    await startHost(allowAll);
    const { url } = urls.sign(window.windowId, RUN, 'page.html');
    const response = await fetchSigned(url);
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="page.html"');
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it.each([
    '../other-run/report.md',
    '/etc/passwd',
    'C:/Windows/win.ini',
    'a/../../x.png',
    'a\\b.png',
    'a//b.png',
    '',
  ])('refuses the traversal %s', (path) => {
    expect(normalizeArtifactPath(path)).toBeNull();
    expect(() => urls.sign(window.windowId, RUN, path)).toThrow(RpcError);
  });

  it.each(['../x', 'run/../x', '.hidden'])('refuses the malformed run ID %s', (runId) => {
    expect(() => urls.sign(window.windowId, runId, 'report.md')).toThrow(RpcError);
  });

  it.skipIf(process.platform === 'win32')(
    'answers 404 for a symlink that escapes the run directory',
    async () => {
      await host.stop();
      await startHost(allowAll);
      const outside = join(makeTempDir(), 'secret.png');
      writeFileSync(outside, PNG);
      symlinkSync(outside, join(runsRoot, RUN, 'captures', 'escape.png'));
      const { url } = urls.sign(window.windowId, RUN, 'captures/escape.png');
      expect((await fetchSigned(url)).status).toBe(404);
    },
  );

  it('answers 404 for a signed path whose file is missing', async () => {
    const { url } = urls.sign(window.windowId, RUN, 'captures/none.png');
    expect((await fetchSigned(url)).status).toBe(404);
  });

  it('publishes only captures images and report.md by default', () => {
    expect(DEFAULT_ARTIFACT_POLICY.isPublic('captures/a/b.JPG')).toBe(true);
    expect(DEFAULT_ARTIFACT_POLICY.isPublic('captures/b.jpeg')).toBe(true);
    expect(DEFAULT_ARTIFACT_POLICY.isPublic('captures/b.gif')).toBe(false);
    expect(DEFAULT_ARTIFACT_POLICY.isPublic('other/b.png')).toBe(false);
    expect(DEFAULT_ARTIFACT_POLICY.isPublic('report.md')).toBe(true);
    expect(DEFAULT_ARTIFACT_POLICY.isPublic('sub/report.md')).toBe(false);
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
