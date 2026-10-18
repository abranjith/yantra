/**
 * `serveTaskSites()`: one loopback server for every task-fidelity site, routed
 * by the `Host` header (FEAT-049 TASK-001).
 *
 * The server keeps its own request log. The harness counts network fetches from
 * that log, independently of anything the run reports about itself, so a run
 * that under-reports its own fetching is caught by a second witness.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, type Socket } from 'node:net';

import { closeServer, listen } from '../../fixtures/serve.js';

import { FormStateSchema, type FormState } from './form-state.js';
import { originOf, siteForHost, type SiteName } from './sites.js';
import { fixtureTlsIdentity } from './tls.js';

/** One request the fixture server received. */
export interface RequestLogEntry {
  /** 1-based arrival order. */
  readonly seq: number;
  /** How the request arrived: plain HTTP or TLS. */
  readonly scheme: 'http' | 'https';
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
  stateLog(): readonly FormState[];
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
  let states: FormState[] = [];
  const handler =
    (scheme: RequestLogEntry['scheme']) =>
    (request: IncomingMessage, response: ServerResponse): void => {
      if (new URL(request.url ?? '/', 'http://fixture.invalid').pathname === '/__fixture/state') {
        void receiveState(request, response, states);
        return;
      }
      const status = respond(request, response);
      seq += 1;
      log.push(entryOf(request, status, seq, scheme));
    };
  const plain = createServer(handler('http'));
  const secure = createHttpsServer(fixtureTlsIdentity(), handler('https'));
  // One port answers both schemes, as a real site's 80/443 pair would: Chrome's
  // host-resolver rule maps a host to exactly one port, so the first byte of
  // each connection decides — 0x16 opens a TLS handshake.
  const sockets = new Set<Socket>();
  const front = createNetServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // A client that abandons a handshake is not a fixture failure.
    socket.on('error', () => undefined);
    socket.once('data', (chunk) => {
      socket.pause();
      socket.unshift(chunk);
      (chunk[0] === TLS_HANDSHAKE ? secure : plain).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
  const port = await listen(front);
  return {
    port,
    origin: originOf,
    requests: () => [...log],
    stateLog: () => [...states],
    reset: () => {
      log = [];
      seq = 0;
      states = [];
    },
    close: async () => {
      // Chrome holds keep-alive connections open; close them so `close()`
      // resolves when the harness is done rather than when Chrome is.
      plain.closeAllConnections();
      secure.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await closeServer(front);
    },
  };
}

async function receiveState(
  request: IncomingMessage,
  response: ServerResponse,
  states: FormState[],
): Promise<void> {
  if (
    request.method !== 'POST' ||
    request.headers['content-type']?.split(';')[0] !== 'application/json'
  ) {
    response.writeHead(415).end();
    request.resume();
    return;
  }
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > 65536) {
        response.writeHead(413).end();
        request.resume();
        return;
      }
      chunks.push(bytes);
    }
    const result = FormStateSchema.safeParse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
    );
    if (!result.success) {
      response.writeHead(400).end();
      return;
    }
    states.push(result.data);
    response.writeHead(204).end();
  } catch {
    if (!response.headersSent) response.writeHead(400).end();
  }
}

/** The first byte of a TLS ClientHello record. */
const TLS_HANDSHAKE = 0x16;

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

function entryOf(
  request: IncomingMessage,
  status: number,
  seq: number,
  scheme: RequestLogEntry['scheme'],
): RequestLogEntry {
  const url = new URL(request.url ?? '/', 'http://fixture.invalid');
  const userAgent = request.headers['user-agent'] ?? '';
  return {
    seq,
    scheme,
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
