/**
 * App window sessions (FEAT-065 TASK-003, plan §7, D18).
 *
 * A window proves itself in three steps:
 *
 * 1. A **launch code** (256-bit, single use, 60 s) reaches it in the URL
 *    fragment from `yantra ui`. Only its SHA-256 is kept.
 * 2. `POST /session {code}` (exact Origin, enforced by the request guard)
 *    exchanges it for a `window_capability` held in JavaScript memory only,
 *    plus an `HttpOnly; SameSite=Strict` cookie.
 * 3. Every RPC socket presents the cookie and then the capability.
 *
 * A capability expires 5 minutes after its window's last socket closes, and
 * 12 hours after creation regardless. A **resume code** (single use, 60 s,
 * issued over an authenticated socket) lets a reloaded tab get a new
 * capability for the same window; exchanging it revokes the old one. The
 * code, cookie and capability values are never stored or logged.
 *
 * Cookies ignore ports and every app window shares one browser profile, so
 * one cookie identifies the profile and may carry several windows; each
 * window still has its own capability.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { HostRoute } from './host.js';
import { readBodyOr413, sendJson } from './request-guard.js';

/** How long a launch or resume code is valid. */
export const CODE_TTL_MS = 60_000;
/** How long a capability outlives its window's last socket. */
export const DISCONNECT_GRACE_MS = 5 * 60_000;
/** A capability's absolute lifetime. */
export const ABSOLUTE_TTL_MS = 12 * 60 * 60_000;
/** The session cookie's name. */
export const SESSION_COOKIE = 'yantra_session';
/** The uniform refusal body for any failed exchange. */
export const SESSION_REFUSED = { error: 'session_refused' } as const;

const MAX_CODE_LENGTH = 128;

/** Constant-time equality of two digests. */
export type DigestEqual = (left: Buffer, right: Buffer) => boolean;

/** Compares with `crypto.timingSafeEqual`; unequal lengths are simply unequal. */
export const constantTimeEqual: DigestEqual = (left, right) =>
  left.length === right.length && timingSafeEqual(left, right);

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export interface SessionStoreDeps {
  /** Epoch milliseconds. */
  readonly now?: () => number;
  readonly random?: (size: number) => Buffer;
  readonly equal?: DigestEqual;
}

interface CodeEntry {
  readonly hash: Buffer;
  readonly kind: 'launch' | 'resume';
  readonly expiresAt: number;
  /** Resume codes only. */
  readonly windowId: string | null;
  used: boolean;
}

/** One app window, in host memory only. */
export interface WindowSession {
  readonly windowId: string;
  cookieHash: Buffer;
  capabilityHash: Buffer;
  readonly createdAt: number;
  readonly absoluteExpiry: number;
  /** When the last socket closed; set at creation until one connects. */
  disconnectedAt: number | null;
  openSockets: number;
  readonly subscriptions: Set<string>;
  lastAttendanceAt: number | null;
}

/** An issued code and when it stops working. */
export interface IssuedCode {
  readonly code: string;
  readonly expiresAt: number;
}

/** A successful exchange: the only place these values ever appear. */
export interface SessionGrant {
  readonly windowId: string;
  readonly windowCapability: string;
  readonly cookie: string;
  readonly absoluteExpiry: number;
  readonly resumed: boolean;
}

/** Why a window stopped being valid. */
export type ExpiryReason = 'disconnected' | 'absolute' | 'revoked';

/** The in-memory session store; see the module comment. */
export class SessionStore {
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;
  private readonly equal: DigestEqual;
  private readonly codes = new Map<string, CodeEntry>();
  private readonly windows = new Map<string, WindowSession>();
  private readonly listeners = new Set<(windowId: string, reason: ExpiryReason) => void>();

  public constructor(deps: SessionStoreDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? randomBytes;
    this.equal = deps.equal ?? constantTimeEqual;
  }

  /** A fresh single-use launch code for `yantra ui`. */
  public issueLaunchCode(): IssuedCode {
    return this.issueCode('launch', null);
  }

  /**
   * A single-use code that lets `windowId`'s tab start a new session for the
   * same window (a reload or the D17 stale-asset reload). Null when the window
   * is no longer live.
   */
  public issueResumeCode(windowId: string): IssuedCode | null {
    if (this.liveWindow(windowId) === null) return null;
    return this.issueCode('resume', windowId);
  }

  /**
   * Exchanges a launch or resume code. Returns null for an unknown, used or
   * expired code, or a resume code whose window has expired; every refusal
   * is indistinguishable to the caller.
   *
   * @param presentedCookie the request's `yantra_session` value, if any; a
   *   live one is kept so windows in one browser profile share it.
   */
  public exchange(code: unknown, presentedCookie: string | null = null): SessionGrant | null {
    this.sweep();
    if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_LENGTH) {
      return null;
    }
    const hash = sha256(code);
    const entry = this.codes.get(hash.toString('hex'));
    if (entry === undefined || !this.equal(entry.hash, hash)) return null;
    if (entry.used || this.now() > entry.expiresAt) return null;
    let window: WindowSession | null = null;
    if (entry.kind === 'resume') {
      window = entry.windowId === null ? null : this.liveWindow(entry.windowId);
      if (window === null) return null;
    }
    entry.used = true;

    const capability = this.token(32);
    const cookie = this.reusableCookie(presentedCookie) ?? this.token(32);
    const now = this.now();
    if (window === null) {
      const created: WindowSession = {
        windowId: this.token(16),
        cookieHash: sha256(cookie),
        capabilityHash: sha256(capability),
        createdAt: now,
        absoluteExpiry: now + ABSOLUTE_TTL_MS,
        disconnectedAt: now,
        openSockets: 0,
        subscriptions: new Set(),
        lastAttendanceAt: null,
      };
      this.windows.set(created.windowId, created);
      window = created;
    } else {
      // The old capability is revoked; the window keeps its absolute expiry.
      window.capabilityHash = sha256(capability);
      window.cookieHash = sha256(cookie);
      if (window.openSockets === 0) window.disconnectedAt = now;
    }
    return {
      windowId: window.windowId,
      windowCapability: capability,
      cookie,
      absoluteExpiry: window.absoluteExpiry,
      resumed: entry.kind === 'resume',
    };
  }

  /**
   * The live window whose cookie and capability both match, or null. Both
   * comparisons are constant-time over SHA-256 digests.
   */
  public authenticate(cookie: string | null, capability: unknown): WindowSession | null {
    this.sweep();
    if (cookie === null || typeof capability !== 'string' || capability.length === 0) return null;
    const cookieHash = sha256(cookie);
    const capabilityHash = sha256(capability);
    let match: WindowSession | null = null;
    for (const window of this.windows.values()) {
      const cookieOk = this.equal(window.cookieHash, cookieHash);
      const capabilityOk = this.equal(window.capabilityHash, capabilityHash);
      if (cookieOk && capabilityOk) match = window;
    }
    return match;
  }

  /** True when `cookie` belongs to at least one live window (the WebSocket upgrade check). */
  public cookieIsLive(cookie: string | null): boolean {
    this.sweep();
    if (cookie === null) return false;
    const hash = sha256(cookie);
    let live = false;
    for (const window of this.windows.values()) {
      if (this.equal(window.cookieHash, hash)) live = true;
    }
    return live;
  }

  /** The live window, or null. */
  public liveWindow(windowId: string): WindowSession | null {
    const window = this.windows.get(windowId);
    if (window === undefined) return null;
    const reason = this.expiryReason(window);
    if (reason === null) return window;
    this.expire(windowId, reason);
    return null;
  }

  /** Records a newly authenticated socket for the window. */
  public socketOpened(windowId: string): void {
    const window = this.windows.get(windowId);
    if (window === undefined) return;
    window.openSockets += 1;
    window.disconnectedAt = null;
  }

  /** Records a closed socket; the 5-minute grace starts when the last one closes. */
  public socketClosed(windowId: string): void {
    const window = this.windows.get(windowId);
    if (window === undefined) return;
    window.openSockets = Math.max(0, window.openSockets - 1);
    if (window.openSockets === 0) window.disconnectedAt = this.now();
  }

  /** Ends a window now (for example, a revoked capability). */
  public revoke(windowId: string): void {
    if (this.windows.has(windowId)) this.expire(windowId, 'revoked');
  }

  /** Expires every window past its deadline and drops spent codes. Returns expired IDs. */
  public sweep(): string[] {
    const expired: string[] = [];
    for (const window of [...this.windows.values()]) {
      const reason = this.expiryReason(window);
      if (reason !== null) {
        this.expire(window.windowId, reason);
        expired.push(window.windowId);
      }
    }
    const now = this.now();
    for (const [key, entry] of this.codes) {
      if (entry.used || now > entry.expiresAt) this.codes.delete(key);
    }
    return expired;
  }

  /** Called with each expired window; returns an unsubscribe function. */
  public onExpire(listener: (windowId: string, reason: ExpiryReason) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Live window count (for idle exit and Health). */
  public windowCount(): number {
    this.sweep();
    return this.windows.size;
  }

  /** Live windows with at least one open socket. */
  public connectedWindows(): readonly WindowSession[] {
    this.sweep();
    return [...this.windows.values()].filter((window) => window.openSockets > 0);
  }

  private expiryReason(window: WindowSession): ExpiryReason | null {
    const now = this.now();
    if (now >= window.absoluteExpiry) return 'absolute';
    if (window.disconnectedAt !== null && now >= window.disconnectedAt + DISCONNECT_GRACE_MS) {
      return 'disconnected';
    }
    return null;
  }

  private expire(windowId: string, reason: ExpiryReason): void {
    if (!this.windows.delete(windowId)) return;
    for (const [key, entry] of this.codes) {
      if (entry.windowId === windowId) this.codes.delete(key);
    }
    for (const listener of this.listeners) listener(windowId, reason);
  }

  private reusableCookie(presented: string | null): string | null {
    if (presented === null || presented.length === 0 || presented.length > MAX_CODE_LENGTH) {
      return null;
    }
    return this.cookieIsLive(presented) ? presented : null;
  }

  private issueCode(kind: 'launch' | 'resume', windowId: string | null): IssuedCode {
    this.sweep();
    const code = this.token(32);
    const hash = sha256(code);
    const expiresAt = this.now() + CODE_TTL_MS;
    this.codes.set(hash.toString('hex'), { hash, kind, expiresAt, windowId, used: false });
    return { code, expiresAt };
  }

  private token(bytes: number): string {
    return this.random(bytes).toString('base64url');
  }
}

/** The exact `Set-Cookie` value for a session cookie. */
export function sessionCookieHeader(cookie: string): string {
  return `${SESSION_COOKIE}=${cookie}; HttpOnly; SameSite=Strict; Path=/`;
}

/** Reads `yantra_session` from a `Cookie` header, or null. */
export function readSessionCookie(req: Pick<IncomingMessage, 'headers'>): string | null {
  const header = req.headers.cookie;
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === SESSION_COOKIE) {
      const value = part.slice(index + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function refuse(res: ServerResponse, port: number): void {
  sendJson(res, port, 401, SESSION_REFUSED);
}

/**
 * `POST /session {code}`. The request guard has already required the exact
 * Origin. Every refusal is byte-identical.
 */
export function sessionRoute(store: SessionStore, buildId: () => string): HostRoute {
  return async (req, res, { port }) => {
    const path = (req.url ?? '').split('?', 1)[0];
    if (path !== '/session') return false;
    if (req.method !== 'POST') {
      refuse(res, port);
      return true;
    }
    const body = await readBodyOr413(req, res, port);
    if (body === null) return true;
    let code: unknown;
    try {
      code = (JSON.parse(body.toString('utf8')) as { code?: unknown } | null)?.code;
    } catch {
      code = undefined;
    }
    const grant = store.exchange(code, readSessionCookie(req));
    if (grant === null) {
      refuse(res, port);
      return true;
    }
    res.setHeader('Set-Cookie', sessionCookieHeader(grant.cookie));
    sendJson(res, port, 200, {
      window_id: grant.windowId,
      window_capability: grant.windowCapability,
      build_id: buildId(),
      absolute_expiry: new Date(grant.absoluteExpiry).toISOString(),
    });
    return true;
  };
}
