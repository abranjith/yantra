/**
 * Signed artifact URLs `/a/<payload>.<mac>` (FEAT-065 TASK-010, plan §7),
 * gated by the public-artifact allowlist (FEAT-066 TASK-001).
 *
 * `artifact.url {run_id, path}` signs a URL for one window:
 *
 * - payload = base64url JSON `{r: run_id, p: relative path, w: window_id, e: expiry ms}`
 *   (5 minutes);
 * - mac = HMAC-SHA256(host key, window_id ‖ capability hash ‖ payload). The
 *   host key is 256 random bits per host start, in memory only, so a host
 *   restart invalidates every URL; rotating or expiring the window's
 *   capability does too.
 *
 * Signing runs `resolvePublicArtifact` (core) first: the run id must be
 * valid, the path must classify to a `view` or `download` entry of
 * `RUN_ARTIFACT_REGISTRY`, and its `realpath` must stay inside the run
 * directory. `typed` entries (`brief.json`, `document.json`) reach the app
 * only through `read.run_result`.
 *
 * `GET /a/<signed>` requires, in order: the exact Host (request guard), a
 * session cookie of window `w`, a constant-time MAC match, an unexpired `e`
 * and a live window. Then it re-runs the gate, because the file may have
 * changed since signing. The response carries the entry's registry media
 * type and `nosniff`; `download` entries (every HTML file) are attachments;
 * the body streams, so a file over its inline cap is never buffered. Every
 * refusal is the same 404, counted in the log by reason code only.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { posix } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  ArtifactAccessError,
  resolvePublicArtifact,
  type ArtifactAccessCode,
  type PublicArtifact,
} from '@yantra/core';
import {
  ArtifactUrlParams,
  ArtifactUrlResult,
  RUN_ID_MAX_LENGTH,
  type RunArtifactExposure,
} from '@yantra/protocol';
import { z } from 'zod';

import { SILENT_HOST_LOGGER, type HostLogger, type HostRoute } from './host.js';
import { applySecurityHeaders, sendStatus } from './request-guard.js';
import { RpcError, type RpcMethodRegistry } from './rpc-server.js';
import { readSessionCookie, type SessionStore } from './sessions.js';

/** How long a signed URL works. */
export const ARTIFACT_URL_TTL_MS = 5 * 60_000;
/** URL prefix of signed artifacts. */
export const ARTIFACT_PREFIX = '/a/';

/** The exposures a signed URL may serve; `typed` files go through typed reads. */
export const SIGNABLE_EXPOSURES: readonly RunArtifactExposure[] = ['view', 'download'];

/** Why a request for an artifact was refused, as counted in the host log. */
export type ArtifactRefusal = ArtifactAccessCode | 'method' | 'signature' | 'read';

/** Resolves one public run file; injected in tests. */
export type ArtifactResolver = (
  runsRoot: string,
  runId: string,
  relPath: string,
) => Promise<PublicArtifact>;

/** The production resolver: the core gate, limited to {@link SIGNABLE_EXPOSURES}. */
export const resolveSignableArtifact: ArtifactResolver = (runsRoot, runId, relPath) =>
  resolvePublicArtifact(runsRoot, runId, relPath, { exposures: SIGNABLE_EXPOSURES });

/** The RPC error a gate refusal becomes at signing time. */
function signingError(error: ArtifactAccessError, path: string): RpcError {
  switch (error.code) {
    case 'invalid_run_id':
      return new RpcError('invalid_params', 'The run ID is malformed.');
    case 'not_found':
      return new RpcError('not_found', `${path} does not exist in this run.`);
    case 'too_large':
      return new RpcError('too_large', `${path} is too large to open here.`);
    case 'not_public':
    case 'outside_run':
      return new RpcError(
        'not_allowed',
        'That file is not an artifact the app can open.',
        'Open the run directory from the terminal instead.',
      );
  }
}

const Payload = z
  .object({
    r: z.string().min(1).max(RUN_ID_MAX_LENGTH),
    p: z.string().min(1).max(512),
    w: z.string().min(1).max(64),
    e: z.number().int().positive(),
  })
  .strict();
type Payload = z.infer<typeof Payload>;

export interface ArtifactUrlDeps {
  readonly sessions: SessionStore;
  /** The runs directory (`runsRoot()`). */
  readonly runsRoot: string;
  /** Defaults to {@link resolveSignableArtifact}. */
  readonly resolve?: ArtifactResolver;
  readonly now?: () => number;
  /** The per-host-start key; defaults to 256 random bits. */
  readonly hostKey?: Buffer;
  readonly logger?: HostLogger;
}

/** Signs and serves artifact URLs; see the module comment. */
export class ArtifactUrls {
  private readonly hostKey: Buffer;
  private readonly resolver: ArtifactResolver;
  private readonly now: () => number;
  private readonly logger: HostLogger;
  private denials = 0;
  private readonly reasons: Partial<Record<ArtifactRefusal, number>> = {};

  public constructor(private readonly deps: ArtifactUrlDeps) {
    this.hostKey = deps.hostKey ?? randomBytes(32);
    this.resolver = deps.resolve ?? resolveSignableArtifact;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? SILENT_HOST_LOGGER;
  }

  /** Refusals so far. */
  public get denialCount(): number {
    return this.denials;
  }

  /** Refusals so far, by reason code. */
  public get denialsByReason(): Readonly<Partial<Record<ArtifactRefusal, number>>> {
    return { ...this.reasons };
  }

  /**
   * Signs `/a/…` for `windowId` after the allowlist gate, or throws an
   * {@link RpcError} saying why the file cannot be opened.
   */
  public async sign(
    windowId: string,
    runId: string,
    path: string,
  ): Promise<{ url: string; expiresAt: number }> {
    const window = this.deps.sessions.liveWindow(windowId);
    if (window === null) {
      throw new RpcError(
        'unauthorized',
        'This window’s session has ended.',
        'Run `yantra ui` again.',
      );
    }
    let artifact: PublicArtifact;
    try {
      artifact = await this.resolver(this.deps.runsRoot, runId, path);
    } catch (error) {
      if (error instanceof ArtifactAccessError) {
        this.count(error.code);
        throw signingError(error, path);
      }
      throw error;
    }
    const expiresAt = this.now() + ARTIFACT_URL_TTL_MS;
    const payload = Buffer.from(
      JSON.stringify({ r: runId, p: artifact.relPath, w: windowId, e: expiresAt }),
      'utf8',
    ).toString('base64url');
    const mac = this.mac(windowId, window.capabilityHash, payload).toString('base64url');
    return { url: `${ARTIFACT_PREFIX}${payload}.${mac}`, expiresAt };
  }

  /** The `GET /a/<signed>` route. */
  public readonly route: HostRoute = async (req, res, { port }) => {
    const rawPath = (req.url ?? '').split('?', 1)[0] ?? '';
    if (!rawPath.startsWith(ARTIFACT_PREFIX)) return false;
    const deny = (reason: ArtifactRefusal): true => {
      this.count(reason);
      sendStatus(res, port, 404);
      return true;
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny('method');
    const verified = this.verify(rawPath.slice(ARTIFACT_PREFIX.length), readSessionCookie(req));
    if (verified === null) return deny('signature');
    let artifact: PublicArtifact;
    try {
      // Again at serve time: the file may have been replaced since signing.
      artifact = await this.resolver(this.deps.runsRoot, verified.r, verified.p);
    } catch (error) {
      return deny(error instanceof ArtifactAccessError ? error.code : 'read');
    }
    const stream = createReadStream(artifact.absPath);
    const opened = await new Promise<boolean>((resolve) => {
      stream.once('open', () => {
        resolve(true);
      });
      stream.once('error', () => {
        resolve(false);
      });
    });
    if (!opened) return deny('read');

    applySecurityHeaders(res, port);
    res.setHeader('Content-Type', artifact.entry.media_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', String(artifact.bytes));
    if (artifact.entry.exposure === 'download') {
      const name = posix.basename(artifact.relPath).replace(/[^A-Za-z0-9._-]/gu, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    }
    res.writeHead(200);
    if (req.method === 'HEAD') {
      stream.destroy();
      res.end();
      return true;
    }
    // Streamed: a file over its inline cap is never held in memory.
    await pipeline(stream, res).catch(() => {
      res.destroy();
    });
    return true;
  };

  /** Checks a signed token for the presenting cookie; null on any failure. */
  public verify(token: string, cookie: string | null): Payload | null {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
    const payloadText = token.slice(0, dot);
    let payload: Payload;
    try {
      const parsed = Payload.safeParse(
        JSON.parse(Buffer.from(payloadText, 'base64url').toString('utf8')),
      );
      if (!parsed.success) return null;
      payload = parsed.data;
    } catch {
      return null;
    }
    const window = this.deps.sessions.windowForCookie(cookie, payload.w);
    if (window === null) return null;
    const expected = this.mac(payload.w, window.capabilityHash, payloadText);
    const presented = Buffer.from(token.slice(dot + 1), 'base64url');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
    if (this.now() > payload.e) return null;
    return this.deps.sessions.liveWindow(payload.w) === null ? null : payload;
  }

  private mac(windowId: string, capabilityHash: Buffer, payload: string): Buffer {
    return createHmac('sha256', this.hostKey)
      .update(windowId, 'utf8')
      .update(capabilityHash)
      .update(payload, 'utf8')
      .digest();
  }

  /** Counts a refusal; the log names the reason code only, never the path or URL. */
  private count(reason: ArtifactRefusal): void {
    this.denials += 1;
    this.reasons[reason] = (this.reasons[reason] ?? 0) + 1;
    this.logger.warn({ reason, count: this.denials }, 'artifact refused');
  }
}

/** Registers `artifact.url`. */
export function registerArtifactUrls(methods: RpcMethodRegistry, urls: ArtifactUrls): void {
  methods.register('artifact.url', {
    params: ArtifactUrlParams,
    result: ArtifactUrlResult,
    handler: async ({ run_id: runId, path }, { windowId }) => {
      const signed = await urls.sign(windowId, runId, path);
      return { url: signed.url, expires_at: new Date(signed.expiresAt).toISOString() };
    },
  });
}
