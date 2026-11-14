// @no-llm
/**
 * Serving the embedded web build (FEAT-065 TASK-002): cache policy, route
 * fallback, the content-type allowlist and traversal refusal.
 */

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostStartError } from '../../../src/ui/host/errors.js';
import { AppHost } from '../../../src/ui/host/host.js';
import { IMMUTABLE_CACHE, safeSegments } from '../../../src/ui/host/static-assets.js';

import { INDEX_HTML, cleanupTempDirs, makeTempDir, makeWebBuild, rawRequest } from './support.js';

let host: AppHost;
let port: number;
let webRoot: string;

beforeEach(async () => {
  webRoot = makeWebBuild();
  host = new AppHost({ assetsRoot: webRoot });
  ({ port } = await host.start());
});

afterEach(async () => {
  await host.stop();
  cleanupTempDirs();
});

describe('index.html', () => {
  it.each(['/', '/index.html'])('serves %s with no-store', async (path) => {
    const response = await rawRequest(port, { path });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe(INDEX_HTML);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([
    '/runs',
    '/runs/20261111T100000Z-research-0000abcd',
    '/runs/20261111T100000Z-research-0000abcd/audit',
    '/runs/20261111T100000Z-research-0000abcd/artifacts/tool-calls.jsonl',
    '/runs/20261111T100000Z-research-0000abcd/artifacts/agent/session-1.jsonl',
    '/settings/theme',
  ])('falls back to index.html for the app route %s', async (path) => {
    const response = await rawRequest(port, { path });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe(INDEX_HTML);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('keeps query strings and fragments off the file lookup', async () => {
    const response = await rawRequest(port, { path: '/?code=x' });
    expect(response.status).toBe(200);
  });

  it('answers HEAD with headers and no body', async () => {
    const response = await rawRequest(port, { method: 'HEAD', path: '/' });
    expect(response.status).toBe(200);
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength(INDEX_HTML)));
    expect(response.body.length).toBe(0);
  });
});

describe('hashed assets', () => {
  it.each([
    ['/assets/main-AbC123xy.js', 'text/javascript; charset=utf-8'],
    ['/assets/main-AbC123xy.css', 'text/css; charset=utf-8'],
    ['/assets/font-Zz9.woff2', 'font/woff2'],
  ])('serves %s as %s, cached immutably', async (path, type) => {
    const response = await rawRequest(port, { path });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe(type);
    expect(response.headers['cache-control']).toBe(IMMUTABLE_CACHE);
  });

  it('caches hashed assets differently from index.html', async () => {
    const asset = await rawRequest(port, { path: '/assets/main-AbC123xy.js' });
    const index = await rawRequest(port, { path: '/' });
    expect(asset.headers['cache-control']).not.toBe(index.headers['cache-control']);
  });

  it('refuses a file whose extension is not on the allowlist', async () => {
    const response = await rawRequest(port, { path: '/assets/notes.txt' });
    expect(response.status).toBe(404);
  });

  it('answers 404 for a missing asset instead of falling back to index.html', async () => {
    const response = await rawRequest(port, { path: '/assets/missing-0000.js' });
    expect(response.status).toBe(404);
  });

  it('answers 404 for a file-looking path outside assets/', async () => {
    const response = await rawRequest(port, { path: '/build-id.json' });
    expect(response.status).toBe(404);
  });

  it('answers 404 for a directory', async () => {
    mkdirSync(join(webRoot, 'assets', 'dir.js'));
    const response = await rawRequest(port, { path: '/assets/dir.js' });
    expect(response.status).toBe(404);
  });
});

describe('traversal', () => {
  it.each([
    '/assets/../../host.lock',
    '/assets/../index.html',
    '/assets/%2e%2e/%2e%2e/host.lock',
    '/assets/%2E%2E/x.js',
    '/assets/..%2fhost.lock',
    '/assets/..%5chost.lock',
    '/assets/%00.js',
    '/assets//main-AbC123xy.js',
    '/assets/./main-AbC123xy.js',
    '/assets/%E0%A4%A.js',
  ])('answers 404 for %s', async (path) => {
    const response = await rawRequest(port, { path });
    expect(response.status).toBe(404);
  });

  it('answers 404 for a backslash path', async () => {
    const response = await rawRequest(port, { path: '/assets\\..\\..\\host.lock' });
    expect(response.status).toBe(404);
  });

  it.skipIf(process.platform === 'win32')(
    'answers 404 for a symlink that escapes the asset root',
    async () => {
      const outside = join(makeTempDir(), 'secret.js');
      writeFileSync(outside, 'secret');
      symlinkSync(outside, join(webRoot, 'assets', 'link.js'));
      const response = await rawRequest(port, { path: '/assets/link.js' });
      expect(response.status).toBe(404);
    },
  );

  it.each([
    ['/', []],
    ['/assets/a.js', ['assets', 'a.js']],
    ['/a/../b', null],
    ['relative', null],
    ['/a%2Fb', null],
  ])('splits %s safely', (path, expected) => {
    expect(safeSegments(path)).toEqual(expected);
  });
});

describe('missing assets', () => {
  it('fails to start with assets_missing and a rebuild remediation', async () => {
    const missing = new AppHost({ assetsRoot: join(makeTempDir(), 'web') });
    const error = await missing.start().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostStartError);
    expect(error).toMatchObject({
      code: 'assets_missing',
      remediation: 'Rebuild Yantra (pnpm build).',
    });
  });

  it('fails with assets_missing when index.html is absent', async () => {
    const root = makeTempDir();
    mkdirSync(join(root, 'assets'));
    const error = await new AppHost({ assetsRoot: root })
      .start()
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'assets_missing' });
  });
});
