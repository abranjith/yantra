/**
 * The window's session with its host (FEAT-065 TASK-003/011, plan §7).
 *
 * - A launch code (from the URL fragment) or, after a reload, a stored
 *   **resume code** is exchanged through `POST /session` for a
 *   `window_capability`. The capability lives in this module's memory only:
 *   never storage, the URL or a cookie.
 * - While connected, a fresh resume code (single use, 60 s) is fetched every
 *   45 s into this tab's `sessionStorage`, so a reload can resume the same
 *   window. A stored code is removed before it is used.
 */

import type { SessionGrantResponse } from '@yantra/protocol';

/** The `sessionStorage` key of the current resume code. */
export const RESUME_CODE_KEY = 'yantra.resume_code';
/** How often the resume code is rotated. */
export const RESUME_ROTATE_MS = 45_000;

/** The slice of `fetch` the session uses. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    credentials: 'same-origin';
    cache: 'no-store';
  },
) => Promise<{ readonly ok: boolean; json(): Promise<unknown> }>;

/** The slice of `Storage` the session uses. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface SessionDeps {
  readonly fetch: FetchLike;
  /** This tab's `sessionStorage`; null where storage is unavailable. */
  readonly storage: StorageLike | null;
}

function isGrant(value: unknown): value is SessionGrantResponse {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.window_id === 'string' &&
    typeof record.window_capability === 'string' &&
    typeof record.build_id === 'string' &&
    typeof record.absolute_expiry === 'string'
  );
}

/** See the module comment. */
export class SessionClient {
  private capabilityValue: string | null = null;
  private grantValue: Omit<SessionGrantResponse, 'window_capability'> | null = null;

  public constructor(private readonly deps: SessionDeps) {}

  /** The capability, or null before a successful exchange. */
  public capability(): string | null {
    return this.capabilityValue;
  }

  /** The window's ID and expiry (never the capability). */
  public grant(): Omit<SessionGrantResponse, 'window_capability'> | null {
    return this.grantValue;
  }

  /**
   * Opens the session from `launchCode`, else from a stored resume code.
   * Returns false when neither works (the session ended).
   */
  public async open(launchCode: string | null): Promise<boolean> {
    if (launchCode !== null && (await this.exchange(launchCode))) return true;
    const resume = this.readStored();
    // Removed before use: a code is single use whether or not it works.
    this.clearStored();
    return resume !== null && this.exchange(resume);
  }

  /** Stores a freshly issued resume code for this tab. */
  public storeResumeCode(code: string): void {
    try {
      this.deps.storage?.setItem(RESUME_CODE_KEY, code);
    } catch {
      // Storage may be unavailable; a reload then ends the session.
    }
  }

  private async exchange(code: string): Promise<boolean> {
    let body: unknown;
    try {
      const response = await this.deps.fetch('/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) return false;
      body = await response.json();
    } catch {
      return false;
    }
    if (!isGrant(body)) return false;
    const { window_capability: capability, ...grant } = body;
    this.capabilityValue = capability;
    this.grantValue = grant;
    return true;
  }

  private readStored(): string | null {
    try {
      return this.deps.storage?.getItem(RESUME_CODE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  private clearStored(): void {
    try {
      this.deps.storage?.removeItem(RESUME_CODE_KEY);
    } catch {
      // Nothing stored, or storage unavailable.
    }
  }
}

/** The RPC slice resume rotation needs. */
export interface ResumeRpc {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  readonly connected: boolean;
}

/** Resume rotation: `rotate` fetches a code now (call it on every hello). */
export interface ResumeRotation {
  rotate(): void;
  stop(): void;
}

/**
 * Fetches a resume code now and every 45 s while connected.
 */
export function startResumeRotation(
  rpc: ResumeRpc,
  session: SessionClient,
  timers: {
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  } = {
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    clearInterval: (handle) => {
      window.clearInterval(handle as number);
    },
  },
): ResumeRotation {
  const rotate = (): void => {
    if (!rpc.connected) return;
    void rpc
      .request<{ code: string }>('session.resume_code')
      .then(({ code }) => {
        session.storeResumeCode(code);
      })
      .catch(() => undefined);
  };
  rotate();
  const handle = timers.setInterval(rotate, RESUME_ROTATE_MS);
  return {
    rotate,
    stop: () => {
      timers.clearInterval(handle);
    },
  };
}
