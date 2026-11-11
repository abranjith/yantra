/**
 * The app host's HTTP boundary (FEAT-065 TASK-002, plan D18).
 *
 * The host listens on `127.0.0.1` only, and every request passes this guard
 * before any route runs:
 *
 * - `Host` must be exactly `127.0.0.1:<port>` (421, no body): a DNS-rebinding
 *   page reaches the port under its own host name and is refused.
 * - Every method other than GET/HEAD needs `Origin` exactly
 *   `http://127.0.0.1:<port>` (403): no other page, loopback port included,
 *   can post to the host.
 * - Bodies are capped at 1 MiB (413) without buffering the excess.
 * - No CORS header is ever sent.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Largest request body the host reads (1 MiB). */
export const MAX_REQUEST_BODY_BYTES = 1_048_576;

/** The only `Host` header value the host answers. */
export function expectedHost(port: number): string {
  return `127.0.0.1:${port}`;
}

/** The only origin allowed to make a state-changing request. */
export function expectedOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** The Content-Security-Policy every response carries. */
export function contentSecurityPolicy(port: number): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob:",
    "font-src 'self'",
    `connect-src 'self' ws://127.0.0.1:${port}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** Headers on every response, error responses included. */
export function securityHeaders(port: number): Readonly<Record<string, string>> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(port),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

/** Sets {@link securityHeaders} on `res`. */
export function applySecurityHeaders(res: ServerResponse, port: number): void {
  for (const [name, value] of Object.entries(securityHeaders(port))) res.setHeader(name, value);
}

/** Why a request was refused before routing. */
export type GuardRefusal =
  | { readonly status: 421; readonly reason: 'host' }
  | { readonly status: 403; readonly reason: 'origin' };

/** True for the methods that never need an Origin check. */
export function isSafeMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD';
}

/** True when the request's `Host` is exactly this host's canonical origin. */
export function hostMatches(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  return req.headers.host === expectedHost(port);
}

/** True when the request's `Origin` is exactly this host's canonical origin. */
export function originMatches(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  return req.headers.origin === expectedOrigin(port);
}

/**
 * Checks `Host` and, for unsafe methods, `Origin`. Returns null when the
 * request may be routed.
 */
export function checkRequest(
  req: Pick<IncomingMessage, 'headers' | 'method'>,
  port: number,
): GuardRefusal | null {
  if (!hostMatches(req, port)) return { status: 421, reason: 'host' };
  if (!isSafeMethod(req.method) && !originMatches(req, port)) {
    return { status: 403, reason: 'origin' };
  }
  return null;
}

/** The request body exceeded {@link MAX_REQUEST_BODY_BYTES}. */
export class BodyTooLargeError extends Error {
  public override readonly name = 'BodyTooLargeError';
  public constructor(public readonly limit: number) {
    super(`The request body exceeds ${limit} bytes.`);
  }
}

/**
 * Reads a request body up to `limit` bytes. A declared `Content-Length` over
 * the limit is refused before any byte is read; a body that grows past it
 * stops being kept, so the excess is never buffered.
 */
export function readBody(req: IncomingMessage, limit = MAX_REQUEST_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new BodyTooLargeError(limit));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      total += chunk.length;
      if (total > limit) {
        over = true;
        chunks.length = 0;
        reject(new BodyTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    });
    req.once('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.once('error', (error) => {
      if (!over) reject(error);
    });
  });
}

/**
 * Reads the body for a route, answering 413 (and returning null) when it is
 * over the limit. Connection-level read errors also answer and return null.
 */
export async function readBodyOr413(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  limit = MAX_REQUEST_BODY_BYTES,
): Promise<Buffer | null> {
  try {
    return await readBody(req, limit);
  } catch (error) {
    // The rest of an oversized body keeps draining unkept, so the client can
    // finish sending and read this answer.
    sendStatus(res, port, error instanceof BodyTooLargeError ? 413 : 400);
    return null;
  }
}

/**
 * Sends a bodiless or short plain response with the security headers. Used
 * for refusals; the body never echoes request content.
 */
export function sendStatus(
  res: ServerResponse,
  port: number,
  status: number,
  body?: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  applySecurityHeaders(res, port);
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  if (body === undefined) {
    res.setHeader('Content-Length', '0');
    res.writeHead(status);
    res.end();
    return;
  }
  const bytes = Buffer.from(body, 'utf8');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', String(bytes.length));
  res.writeHead(status);
  res.end(bytes);
}

/** Sends a JSON response with the security headers and `no-store`. */
export function sendJson(res: ServerResponse, port: number, status: number, value: unknown): void {
  applySecurityHeaders(res, port);
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(bytes.length));
  res.writeHead(status);
  res.end(bytes);
}
