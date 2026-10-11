/**
 * `serveTaskSites()`: one loopback server for every task-fidelity site, routed
 * by the `Host` header (FEAT-049 TASK-001).
 *
 * The server keeps its own request log. The harness counts network fetches from
 * that log, independently of anything the run reports about itself, so a run
 * that under-reports its own fetching is caught by a second witness.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { closeServer, listen } from '../../fixtures/serve.js';

import { originOf, siteForHost, type SiteName } from './sites.js';

/** One request the fixture server received. */
export interface RequestLogEntry {
  /** 1-based arrival order. */
  readonly seq: number;
  /** The `Host` header's hostname, lowercased, without a port. */
  readonly host: string;
  readonly path: string;
  /** The raw query string without the leading `?`; empty when absent. */
  readonly query: string;
  readonly method: string;
  /** `browser` for a Chrome user agent, `http` for everything else. */
  readonly userAgentClass: 'http' | 'browser';
  /** True for a `/robots.txt` request. */
  readonly robots: boolean;
  /** Response status the server sent. */
  readonly status: number;
  /** Wall-clock arrival time (ms since epoch). */
  readonly at: number;
}

/** A running fixture server. */
export interface TaskSiteServer {
  /** The ephemeral loopback port every `*.yantra.test` host maps to. */
  readonly port: number;
  /** The origin a site is reached at, e.g. `http://faceted-listing.yantra.test`. */
  origin(name: SiteName): string;
  /** A snapshot of the request log, in arrival order. */
  requests(): readonly RequestLogEntry[];
  /** Clear the request log and restart its sequence numbering. */
  reset(): void;
  close(): Promise<void>;
}

const ROBOTS_BODY = 'User-agent: *\nAllow: /\n';

/**
 * Start the task-site server on an ephemeral loopback port.
 *
 * Unknown hosts and unknown paths are answered 404 and logged like any other
 * request, so a probe the harness did not expect is visible rather than silent.
 */
export async function serveTaskSites(): Promise<TaskSiteServer> {
  let log: RequestLogEntry[] = [];
  let seq = 0;
  const server: Server = createServer((request, response) => {
    const status = respond(request, response);
    seq += 1;
    log.push(entryOf(request, status, seq));
  });
  const port = await listen(server);
  return {
    port,
    origin: originOf,
    requests: () => [...log],
    reset: () => {
      log = [];
      seq = 0;
    },
    close: async () => {
      // Chrome holds keep-alive connections open; close them so `close()`
      // resolves when the harness is done rather than when Chrome is.
      server.closeAllConnections();
      await closeServer(server);
    },
  };
}

function respond(request: IncomingMessage, response: ServerResponse): number {
  const url = new URL(request.url ?? '/', 'http://fixture.invalid');
  const site = siteForHost(request.headers.host ?? '');
  if (site !== undefined && url.pathname === '/robots.txt') {
    return send(response, 200, 'text/plain; charset=utf-8', ROBOTS_BODY);
  }
  const page = site?.render(url.pathname, url.searchParams) ?? null;
  if (page === null) return send(response, 404, 'text/plain; charset=utf-8', 'not found');
  return send(response, page.status, page.contentType, page.body);
}

function send(response: ServerResponse, status: number, contentType: string, body: string): number {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body, 'utf8'),
    'cache-control': 'no-store',
  });
  response.end(body);
  return status;
}

function entryOf(request: IncomingMessage, status: number, seq: number): RequestLogEntry {
  const url = new URL(request.url ?? '/', 'http://fixture.invalid');
  const userAgent = request.headers['user-agent'] ?? '';
  return {
    seq,
    host: (request.headers.host ?? '').toLowerCase().replace(/:\d+$/, ''),
    path: url.pathname,
    query: url.search.replace(/^\?/, ''),
    method: request.method ?? 'GET',
    userAgentClass: userAgent.includes('Chrome/') ? 'browser' : 'http',
    robots: url.pathname === '/robots.txt',
    status,
    at: Date.now(),
  };
}
