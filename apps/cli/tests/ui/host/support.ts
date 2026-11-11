/**
 * Shared helpers for the app host suites (FEAT-065): a throwaway web build and
 * a raw HTTP client that can send any `Host`/`Origin` (fetch cannot).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];

/** A temp directory removed by {@link cleanupTempDirs}. */
export function makeTempDir(prefix = 'yantra-host-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const INDEX_HTML =
  '<!doctype html><html><head><meta name="yantra-build-id" content="build-test"></head><body></body></html>';

/** A minimal embedded web build: index.html plus one hashed asset of each kind. */
export function makeWebBuild(): string {
  const root = join(makeTempDir('yantra-web-'), 'web');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), INDEX_HTML);
  writeFileSync(join(root, 'build-id.json'), JSON.stringify({ build_id: 'build-test' }));
  writeFileSync(join(root, 'assets', 'main-AbC123xy.js'), 'console.log("app");');
  writeFileSync(join(root, 'assets', 'main-AbC123xy.css'), 'body{}');
  writeFileSync(join(root, 'assets', 'font-Zz9.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  writeFileSync(join(root, 'assets', 'notes.txt'), 'not on the allowlist');
  return root;
}

export interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface RawRequest {
  readonly method?: string;
  readonly path?: string;
  /** Header map sent verbatim; `host: null` omits the Host header. */
  readonly headers?: Readonly<Record<string, string | null>>;
  readonly body?: string | Buffer;
}

/**
 * Sends one HTTP request to 127.0.0.1:`port` with exactly the given headers.
 * `Host` defaults to the canonical `127.0.0.1:<port>`.
 */
export function rawRequest(port: number, options: RawRequest = {}): Promise<RawResponse> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
  let omitHost = false;
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) {
      if (name.toLowerCase() === 'host') omitHost = true;
      delete headers[name.toLowerCase()];
    } else {
      headers[name.toLowerCase()] = value;
    }
  }
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers,
        // A fresh connection per request: no pooled socket the host may have closed.
        agent: false,
        setHost: !omitHost && headers.host === undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
