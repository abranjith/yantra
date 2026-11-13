// @no-llm
/**
 * Artifact serving through the public allowlist (FEAT-066 TASK-001): what
 * `artifact.url` signs, what `GET /a/…` serves, the registry media types,
 * download-only HTML, streaming past the inline cap, the serve-time gate and
 * logging by reason code only.
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArtifactUrls, registerArtifactUrls } from '../../../src/ui/host/artifact-urls.js';
import { AppHost, type HostLogger } from '../../../src/ui/host/host.js';
import { RpcMethodRegistry, type RpcCallContext } from '../../../src/ui/host/rpc-server.js';
import { SessionStore, type SessionGrant } from '../../../src/ui/host/sessions.js';

import { cleanupTempDirs, makeTempDir, makeWebBuild, rawRequest } from './support.js';

const RUN = '20261111T100000Z-research-0000abcd';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let sessions: SessionStore;
let runsRoot: string;
let runDir: string;
let urls: ArtifactUrls;
let host: AppHost;
let port: number;
let window: SessionGrant;
let warnings: Record<string, unknown>[];

const logger: HostLogger = {
  info: () => undefined,
  warn: (fields) => {
    warnings.push(fields);
  },
  error: () => undefined,
};

function fetchSigned(url: string) {
  return rawRequest(port, { path: url, headers: { cookie: `yantra_session=${window.cookie}` } });
}

async function signError(path: string, runId = RUN): Promise<string | null> {
  try {
    await urls.sign(window.windowId, runId, path);
    return null;
  } catch (error) {
    return (error as { data: { code: string } }).data.code;
  }
}

beforeEach(async () => {
  warnings = [];
  sessions = new SessionStore();
  runsRoot = makeTempDir('yantra-runs-');
  runDir = join(runsRoot, RUN);
  mkdirSync(join(runDir, 'decisions'), { recursive: true });
  mkdirSync(join(runDir, 'agent'), { recursive: true });
  mkdirSync(join(runDir, 'screenshots'), { recursive: true });
  writeFileSync(join(runDir, 'brief.json'), '{"title":"typed only"}');
  writeFileSync(join(runDir, 'brief.md'), '# Brief\n\n<script>alert(1)</script>\n');
  writeFileSync(join(runDir, 'brief.html'), '<script>alert(1)</script>');
  writeFileSync(join(runDir, 'manifest.json'), '{"status":"completed"}');
  writeFileSync(join(runDir, 'events.jsonl'), '{"kind":"task_started"}\n');
  writeFileSync(join(runDir, 'agent', 'session.jsonl'), '{"turn":1}\n');
  writeFileSync(join(runDir, 'screenshots', '1-abcdef123456.png'), PNG);
  writeFileSync(join(runDir, 'screenshots', 'evil.png'), PNG);
  writeFileSync(join(runDir, 'lease.json'), '{"run_token":"SECRET"}');
  writeFileSync(join(runDir, 'decisions', 'x.json'), '{}');
  writeFileSync(join(runDir, 'brief.json.tmp'), '{}');
  window = sessions.exchange(sessions.issueLaunchCode().code)!;
  sessions.socketOpened(window.windowId);
  urls = new ArtifactUrls({ sessions, runsRoot, logger });
  host = new AppHost({ assetsRoot: makeWebBuild(), routes: [urls.route] });
  ({ port } = await host.start());
});

afterEach(async () => {
  await host.stop();
  cleanupTempDirs();
});

describe('artifact.url refuses what the allowlist does not publish', () => {
  it.each([
    ['lease.json', 'not_allowed'],
    ['decisions/x.json', 'not_allowed'],
    ['brief.json.tmp', 'not_allowed'],
    ['screenshots/evil.png', 'not_allowed'],
    ['../x', 'not_allowed'],
    ['../../etc/passwd', 'not_allowed'],
    ['a\\b', 'not_allowed'],
    ['C:/Windows/win.ini', 'not_allowed'],
    ['%2e%2e/x', 'not_allowed'],
    ['unknown.txt', 'not_allowed'],
  ])('%s → %s', async (path, code) => {
    expect(await signError(path)).toBe(code);
  });

  it('refuses typed entries: brief.json reaches the app only through read.run_result', async () => {
    expect(await signError('brief.json')).toBe('not_allowed');
  });

  it('refuses a malformed run id', async () => {
    expect(await signError('report.md', '../x')).toBe('invalid_params');
    expect(await signError('report.md', 'agent-smoke-2026')).toBe('invalid_params');
  });

  it('says not_found for an allowed file the run does not have', async () => {
    expect(await signError('report.md')).toBe('not_found');
  });

  it('refuses through the RPC method too', async () => {
    const methods = new RpcMethodRegistry();
    registerArtifactUrls(methods, urls);
    const call = methods.get('artifact.url')!.handler({ run_id: RUN, path: 'lease.json' }, {
      windowId: window.windowId,
      connection: {},
    } as unknown as RpcCallContext);
    await expect(call).rejects.toMatchObject({ data: { code: 'not_allowed' } });
  });
});

describe('GET /a/… serves with the registry media type', () => {
  it.each([
    ['brief.md', 'text/markdown; charset=utf-8'],
    ['manifest.json', 'application/json; charset=utf-8'],
    ['events.jsonl', 'application/x-ndjson; charset=utf-8'],
    ['agent/session.jsonl', 'application/x-ndjson; charset=utf-8'],
    ['screenshots/1-abcdef123456.png', 'image/png'],
  ])('%s inline as %s with nosniff', async (path, type) => {
    const { url } = await urls.sign(window.windowId, RUN, path);

    const response = await fetchSigned(url);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe(type);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBeUndefined();
  });

  it('serves brief.html only as an attachment', async () => {
    const { url } = await urls.sign(window.windowId, RUN, 'brief.html');

    const response = await fetchSigned(url);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['content-disposition']).toBe('attachment; filename="brief.html"');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('streams a file over its inline cap whole when its exposure allows', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
    writeFileSync(join(runDir, 'brief.md'), big);
    const { url } = await urls.sign(window.windowId, RUN, 'brief.md');

    const response = await fetchSigned(url);

    expect(response.status).toBe(200);
    expect(response.headers['content-length']).toBe(String(big.length));
    expect(response.body.length).toBe(big.length);
  });
});

describe('the serve-time gate', () => {
  it('answers 404 when a signed file is deleted before it is fetched', async () => {
    const { url } = await urls.sign(window.windowId, RUN, 'brief.md');
    rmSync(join(runDir, 'brief.md'));

    expect((await fetchSigned(url)).status).toBe(404);
    expect(urls.denialsByReason.not_found).toBe(1);
  });

  it('answers 404 when a signed directory is swapped for a link that leaves the run', async () => {
    // Arrange: sign a file under agent/, then replace agent/ with a link
    // (a junction on Windows) to a directory outside the run with the same name.
    const { url } = await urls.sign(window.windowId, RUN, 'agent/session.jsonl');
    const outside = makeTempDir('yantra-outside-');
    writeFileSync(join(outside, 'session.jsonl'), '{"leak":"OUTSIDE-SECRET"}\n');
    rmSync(join(runDir, 'agent'), { recursive: true, force: true });
    symlinkSync(outside, join(runDir, 'agent'), 'junction');

    // Act
    const response = await fetchSigned(url);

    // Assert
    expect(response.status).toBe(404);
    expect(response.body.toString()).not.toContain('OUTSIDE-SECRET');
    expect(urls.denialsByReason.outside_run).toBe(1);
  });
});

describe('logging', () => {
  it('logs refusals by reason code only: no path, run id, URL or token', async () => {
    await signError('lease.json');
    const { url } = await urls.sign(window.windowId, RUN, 'brief.md');
    await fetchSigned(`${url}x`);

    expect(warnings.length).toBe(2);
    for (const fields of warnings) {
      expect(Object.keys(fields).sort()).toEqual(['count', 'reason']);
    }
    const text = JSON.stringify(warnings);
    expect(text).not.toContain('lease');
    expect(text).not.toContain(RUN);
    expect(text).not.toContain(url.slice(3, 20));
  });
});
