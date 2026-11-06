import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GALLERY_CSP, serveGallery, type GalleryServer } from './gallery-server.js';

interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

/** Sends the path exactly as written; fetch() would normalize `..` away. */
function rawGet(origin: string, path: string, method = 'GET'): Promise<RawResponse> {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname, port, path, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

describe('@no-llm Drshya gallery server', () => {
  let parent: string;
  let server: GalleryServer;

  beforeAll(async () => {
    parent = await mkdtemp(join(tmpdir(), 'drshya-server-'));
    const root = join(parent, 'site');
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'index.html'), '<!doctype html><title>gallery</title>');
    await writeFile(join(root, 'assets', 'app.js'), 'export {};');
    await writeFile(join(root, 'assets', 'notes.txt'), 'not allowlisted');
    await writeFile(join(parent, 'secret.html'), 'outside the root');
    server = await serveGallery(root);
  });

  afterAll(async () => {
    await server.close();
    await rm(parent, { recursive: true, force: true });
  });

  it('serves index.html for the root path with the security headers', async () => {
    const response = await rawGet(server.origin, '/');

    expect(response.status).toBe(200);
    expect(response.body).toContain('<title>gallery</title>');
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['content-security-policy']).toBe(GALLERY_CSP);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves an allowlisted asset with its content type', async () => {
    const response = await rawGet(server.origin, '/assets/app.js');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
  });

  it('ignores the query string', async () => {
    expect((await rawGet(server.origin, '/index.html?entry=button&theme=dark')).status).toBe(200);
  });

  it.each([
    ['plain traversal', '/../secret.html'],
    ['nested traversal', '/assets/../../secret.html'],
    ['encoded dots', '/%2e%2e/secret.html'],
    ['encoded slash', '/..%2fsecret.html'],
    ['encoded backslash', '/..%5csecret.html'],
    ['double-encoded', '/%252e%252e/secret.html'],
  ])('refuses %s with 404', async (_label, path) => {
    const response = await rawGet(server.origin, path);

    expect(response.status).toBe(404);
    expect(response.body).not.toContain('outside the root');
  });

  it('refuses an unknown extension even inside the root', async () => {
    expect((await rawGet(server.origin, '/assets/notes.txt')).status).toBe(404);
  });

  it('refuses a missing file and a malformed escape', async () => {
    expect((await rawGet(server.origin, '/missing.js')).status).toBe(404);
    expect((await rawGet(server.origin, '/%E0%A4%A.js')).status).toBe(404);
  });

  it('refuses a directory', async () => {
    expect((await rawGet(server.origin, '/assets')).status).toBe(404);
  });

  it('sends the security headers on refusals too', async () => {
    const response = await rawGet(server.origin, '/../secret.html');

    expect(response.headers['content-security-policy']).toBe(GALLERY_CSP);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('allows only GET and HEAD', async () => {
    expect((await rawGet(server.origin, '/index.html', 'HEAD')).status).toBe(200);
    expect((await rawGet(server.origin, '/index.html', 'POST')).status).toBe(405);
  });

  it('binds to loopback only', () => {
    expect(new URL(server.origin).hostname).toBe('127.0.0.1');
  });
});
