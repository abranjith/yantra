/**
 * Signed artifact URLs `/a/<payload>.<mac>` (FEAT-065 TASK-010, plan §7).
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
 * `GET /a/<signed>` requires, in order: the exact Host (request guard), a
 * session cookie of window `w`, a constant-time MAC match, an unexpired `e`
 * and a live window. Then the path must pass the denylist (before any
 * filesystem read) and the public allowlist, and its `realpath` must stay
 * inside the run directory. Every refusal is the same 404, counted in the log.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, posix, relative } from 'node:path';

import { ArtifactUrlParams, ArtifactUrlResult } from '@yantra/protocol';
import { z } from 'zod';

import { SILENT_HOST_LOGGER, type HostLogger, type HostRoute } from './host.js';
import { applySecurityHeaders, sendStatus } from './request-guard.js';
import { RpcError, type RpcMethodRegistry } from './rpc-server.js';
import { readSessionCookie, type SessionStore } from './sessions.js';

/** How long a signed URL works. */
export const ARTIFACT_URL_TTL_MS = 5 * 60_000;
/** URL prefix of signed artifacts. */
export const ARTIFACT_PREFIX = '/a/';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** Which run files the app may fetch. FEAT-066 supplies the registry-backed policy. */
export interface ArtifactPolicy {
  /** True when `relativePath` (POSIX separators) is a public artifact. */
  isPublic(relativePath: string): boolean;
}

/** Until FEAT-066: screenshots under `captures/` and `report.md`, nothing else. */
export const DEFAULT_ARTIFACT_POLICY: ArtifactPolicy = {
  isPublic: (path) =>
    path === 'report.md' || /^captures\/(?:[^/]+\/)*[^/]+\.(?:png|jpe?g)$/iu.test(path),
};

const DENIED_NAMES: ReadonlySet<string> = new Set([
  'lease.json',
  'reconcile.lock',
  'host.lock',
  '.lock',
  'decisions',
  'invocations',
  'profiles',
  'chrome-profile',
  'browser-profile',
  'user-data',
  'user-data-dir',
]);

/**
 * True when any segment is never served (§7): run leases and locks, decision
 * claims, temp files, sockets, the host lock, invocation records and browser
 * profiles. Checked before the allowlist, so a too-broad allowlist cannot
 * expose them.
 */
export function isDenied(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => {
    const lower = segment.toLowerCase();
    return (
      DENIED_NAMES.has(lower) ||
      lower.endsWith('.tmp') ||
      lower.endsWith('.sock') ||
      lower.endsWith('.lock') ||
      lower.endsWith('.mutex')
    );
  });
}

/** Normalizes a client path to a safe relative POSIX path, or null. */
export function normalizeArtifactPath(path: string): string | null {
  if (path.length === 0 || path.length > 512 || path.includes('\0') || path.includes('\\'))
    return null;
  if (path.startsWith('/') || isAbsolute(path) || /^[A-Za-z]:/u.test(path)) return null;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    return null;
  return posix.join(...segments);
}

/** Content types served; anything not an image is an attachment. */
export const ARTIFACT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

const Payload = z
  .object({
    r: z.string().regex(RUN_ID),
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
  readonly policy?: ArtifactPolicy;
  readonly now?: () => number;
  /** The per-host-start key; defaults to 256 random bits. */
  readonly hostKey?: Buffer;
  readonly logger?: HostLogger;
}

/** Signs and serves artifact URLs; see the module comment. */
export class ArtifactUrls {
  private readonly hostKey: Buffer;
  private readonly policy: ArtifactPolicy;
  private readonly now: () => number;
  private readonly logger: HostLogger;
  private denials = 0;

  public constructor(private readonly deps: ArtifactUrlDeps) {
    this.hostKey = deps.hostKey ?? randomBytes(32);
    this.policy = deps.policy ?? DEFAULT_ARTIFACT_POLICY;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? SILENT_HOST_LOGGER;
  }

  /** Refusals so far. */
  public get denialCount(): number {
    return this.denials;
  }

  /**
   * Signs `/a/…` for `windowId`, or throws `not_allowed` for a path the policy
   * does not publish.
   */
  public sign(windowId: string, runId: string, path: string): { url: string; expiresAt: number } {
    const window = this.deps.sessions.liveWindow(windowId);
    if (window === null) {
      throw new RpcError(
        'unauthorized',
        'This window’s session has ended.',
        'Run `yantra ui` again.',
      );
    }
    const relativePath = normalizeArtifactPath(path);
    if (!RUN_ID.test(runId) || relativePath === null) {
      throw new RpcError('invalid_params', 'The run ID or artifact path is malformed.');
    }
    if (isDenied(relativePath) || !this.policy.isPublic(relativePath)) {
      throw new RpcError(
        'not_allowed',
        `${relativePath} is not an artifact the app can open.`,
        'Open the run directory from the terminal instead.',
      );
    }
    const expiresAt = this.now() + ARTIFACT_URL_TTL_MS;
    const payload = Buffer.from(
      JSON.stringify({ r: runId, p: relativePath, w: windowId, e: expiresAt }),
      'utf8',
    ).toString('base64url');
    const mac = this.mac(windowId, window.capabilityHash, payload).toString('base64url');
    return { url: `${ARTIFACT_PREFIX}${payload}.${mac}`, expiresAt };
  }

  /** The `GET /a/<signed>` route. */
  public readonly route: HostRoute = async (req, res, { port }) => {
    const rawPath = (req.url ?? '').split('?', 1)[0] ?? '';
    if (!rawPath.startsWith(ARTIFACT_PREFIX)) return false;
    const deny = (reason: string): true => {
      this.denials += 1;
      this.logger.warn({ reason, count: this.denials }, 'artifact refused');
      sendStatus(res, port, 404);
      return true;
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny('method');
    const verified = this.verify(rawPath.slice(ARTIFACT_PREFIX.length), readSessionCookie(req));
    if (verified === null) return deny('signature');
    const { r: runId, p: relativePath } = verified;
    if (isDenied(relativePath) || !this.policy.isPublic(relativePath)) return deny('policy');
    const contentType = ARTIFACT_CONTENT_TYPES[extname(relativePath).toLowerCase()];
    if (contentType === undefined) return deny('type');
    const file = await this.resolve(runId, relativePath);
    if (file === null) return deny('path');
    const body = await readFile(file).catch(() => null);
    if (body === null) return deny('read');

    applySecurityHeaders(res, port);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', String(body.length));
    if (!contentType.startsWith('image/')) {
      const name = posix.basename(relativePath).replace(/[^A-Za-z0-9._-]/gu, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    }
    res.writeHead(200);
    res.end(req.method === 'HEAD' ? undefined : body);
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

  private async resolve(runId: string, relativePath: string): Promise<string | null> {
    try {
      const runDir = await realpath(join(this.deps.runsRoot, runId));
      const real = await realpath(join(runDir, ...relativePath.split('/')));
      const rel = relative(runDir, real);
      if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null;
      // Re-check the resolved name too: a symlink must not reach a denied file.
      if (isDenied(rel.split(/[\\/]/u).join('/'))) return null;
      return (await stat(real)).isFile() ? real : null;
    } catch {
      return null;
    }
  }
}

/** Registers `artifact.url`. */
export function registerArtifactUrls(methods: RpcMethodRegistry, urls: ArtifactUrls): void {
  methods.register('artifact.url', {
    params: ArtifactUrlParams,
    result: ArtifactUrlResult,
    handler: ({ run_id: runId, path }, { windowId }) => {
      const signed = urls.sign(windowId, runId, path);
      return { url: signed.url, expires_at: new Date(signed.expiresAt).toISOString() };
    },
  });
}
