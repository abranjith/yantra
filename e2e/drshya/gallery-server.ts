/**
 * A static server for the built Drshya gallery (`packages/ui/dist/gallery-site`)
 * that sends the app's own security headers (plan_ui §7), so the harness
 * proves the gallery runs under `default-src 'self'`.
 *
 * Test infrastructure only: binds to 127.0.0.1 on an ephemeral port, serves
 * GET and HEAD for an allowlisted set of file types, and resolves every path
 * with `realpath` inside the root, so traversal and symlinks cannot escape it.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listen } from '../fixtures/serve.js';

/** The app's Content-Security-Policy (plan_ui §7). */
export const GALLERY_CSP = "default-src 'self'";

/** The built gallery, relative to this file. */
export const GALLERY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../packages/ui/dist/gallery-site',
);

/** Every file type the gallery ships; anything else is refused. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': GALLERY_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

export interface GalleryServer {
  /** e.g. `http://127.0.0.1:53124` */
  readonly origin: string;
  close(): Promise<void>;
}

function send(
  response: ServerResponse,
  status: number,
  body: Buffer | string = '',
  contentType = 'text/plain; charset=utf-8',
): void {
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': contentType });
  response.end(body);
}

/**
 * Maps a request path to a file inside `rootReal`, or `null` when the path is
 * malformed, escapes the root, is not a regular file, or has a type outside
 * the allowlist.
 */
export async function resolveGalleryFile(
  rootReal: string,
  requestUrl: string,
): Promise<{ readonly path: string; readonly contentType: string } | null> {
  let pathname: string;
  try {
    // Decode once, so an encoded `..%2f` is judged as the path it names.
    pathname = decodeURIComponent(new URL(requestUrl, 'http://gallery.invalid').pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\u0000')) {
    return null;
  }
  const relativePath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;

  let real: string;
  try {
    real = await realpath(join(rootReal, relativePath));
  } catch {
    return null;
  }
  if (!real.startsWith(rootReal + sep)) {
    return null;
  }

  const contentType = CONTENT_TYPES[extname(real).toLowerCase()];
  if (contentType === undefined) {
    return null;
  }
  const info = await stat(real);
  return info.isFile() ? { path: real, contentType } : null;
}

async function handle(
  rootReal: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405);
    return;
  }
  const file = await resolveGalleryFile(rootReal, request.url ?? '/');
  if (file === null) {
    send(response, 404);
    return;
  }
  const body = await readFile(file.path);
  send(response, 200, request.method === 'HEAD' ? '' : body, file.contentType);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
    server.closeAllConnections();
  });
}

/** Serves `root` (the built gallery by default) on an ephemeral loopback port. */
export async function serveGallery(root: string = GALLERY_ROOT): Promise<GalleryServer> {
  const rootReal = await realpath(root);
  const server = createServer((request, response) => {
    handle(rootReal, request, response).catch(() => {
      if (!response.headersSent) {
        send(response, 500);
      }
    });
  });
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${String(port)}`, close: () => closeServer(server) };
}
