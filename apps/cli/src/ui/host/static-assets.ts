/**
 * Serves the embedded web build (`dist/web`) (FEAT-065 TASK-002).
 *
 * - `GET /` and `/index.html` serve `index.html` with `no-store`, so a new
 *   build is picked up on the next load (D17).
 * - Files under `assets/` are content-hashed by Vite and served `immutable`.
 * - An unknown extensionless path outside `assets/` is an app route and gets
 *   `index.html`, as does every path under `/runs/` (the artifact viewer's
 *   paths end in a file name, FEAT-066); anything else unknown is 404.
 * - Any `..` segment, backslash, NUL or encoded dot is 404 before a path is
 *   built, and every file is `realpath`-checked to stay inside the asset root.
 * - `Content-Type` comes from a fixed extension allowlist; other files are 404.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, sep } from 'node:path';

import { HostStartError } from './errors.js';
import { applySecurityHeaders, sendStatus } from './request-guard.js';

/** Extension → Content-Type. Nothing else is ever served. */
export const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

/** Cache policy of content-hashed files under `assets/`. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/** True when `path` is strictly inside `root` (both already resolved). */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Splits a raw request path into safe segments, or returns null for anything
 * that could traverse: `..`/`.` segments (raw or percent-encoded), a
 * backslash, NUL, an empty segment, or a malformed escape.
 */
export function safeSegments(rawPath: string): readonly string[] | null {
  const pathOnly = rawPath.split(/[?#]/u, 1)[0] ?? '';
  if (!pathOnly.startsWith('/')) return null;
  if (/%2e|%2f|%5c|%00/iu.test(pathOnly)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  const segments = decoded.split('/').slice(1);
  if (segments.length === 1 && segments[0] === '') return [];
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return segments;
}

/** The embedded web build, opened and checked once at host start. */
export class StaticAssets {
  private constructor(
    private readonly root: string,
    private readonly indexHtml: Buffer,
  ) {}

  /**
   * Opens the asset root.
   *
   * @throws HostStartError `assets_missing` when the root or its `index.html`
   *   is absent.
   */
  public static async open(root: string): Promise<StaticAssets> {
    let resolved: string;
    let indexHtml: Buffer;
    try {
      resolved = await realpath(root);
      indexHtml = await readFile(join(resolved, 'index.html'));
    } catch {
      throw new HostStartError(
        'assets_missing',
        `The Yantra app files are missing from ${root}.`,
        'Rebuild Yantra (pnpm build).',
      );
    }
    return new StaticAssets(resolved, indexHtml);
  }

  /** The absolute, resolved asset root. */
  public get directory(): string {
    return this.root;
  }

  /** Serves a GET/HEAD for a static path. Always responds. */
  public async serve(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
    const segments = safeSegments(req.url ?? '/');
    if (segments === null) {
      sendStatus(res, port, 404);
      return;
    }
    const isIndex =
      segments.length === 0 || (segments.length === 1 && segments[0] === 'index.html');
    if (isIndex) {
      this.sendIndex(req, res, port);
      return;
    }
    const isAsset = segments[0] === 'assets' && segments.length > 1;
    if (!isAsset) {
      // Extensionless paths are client routes; a file-looking path is not one,
      // except under /runs/, where the viewer route names a run file (FEAT-066).
      const appRoute =
        segments[0] === 'runs' || extname(segments[segments.length - 1] ?? '') === '';
      if (appRoute) this.sendIndex(req, res, port);
      else sendStatus(res, port, 404);
      return;
    }
    const contentType = ASSET_CONTENT_TYPES[extname(segments[segments.length - 1] ?? '')];
    if (contentType === undefined) {
      sendStatus(res, port, 404);
      return;
    }
    const file = await this.resolveFile(segments);
    if (file === null) {
      sendStatus(res, port, 404);
      return;
    }
    const body = await readFile(file).catch(() => null);
    if (body === null) {
      sendStatus(res, port, 404);
      return;
    }
    this.send(req, res, port, body, contentType, IMMUTABLE_CACHE);
  }

  private async resolveFile(segments: readonly string[]): Promise<string | null> {
    const candidate = join(this.root, ...segments);
    if (!isInside(this.root, candidate)) return null;
    try {
      const real = await realpath(candidate);
      if (!isInside(this.root, real) || !real.startsWith(`${this.root}${sep}`)) return null;
      return (await stat(real)).isFile() ? real : null;
    } catch {
      return null;
    }
  }

  private sendIndex(req: IncomingMessage, res: ServerResponse, port: number): void {
    this.send(req, res, port, this.indexHtml, ASSET_CONTENT_TYPES['.html'] ?? '', 'no-store');
  }

  private send(
    req: IncomingMessage,
    res: ServerResponse,
    port: number,
    body: Buffer,
    contentType: string,
    cacheControl: string,
  ): void {
    applySecurityHeaders(res, port);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('Content-Length', String(body.length));
    res.writeHead(200);
    res.end(req.method === 'HEAD' ? undefined : body);
  }
}
