// @no-llm
/**
 * App window sessions (FEAT-065 TASK-003): launch and resume codes, the
 * `POST /session` exchange, per-window capabilities and expiry.
 */

import { timingSafeEqual } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppHost } from '../../../src/ui/host/host.js';
import {
  ABSOLUTE_TTL_MS,
  CODE_TTL_MS,
  DISCONNECT_GRACE_MS,
  SessionStore,
  constantTimeEqual,
  readSessionCookie,
  sessionCookieHeader,
  sessionRoute,
  type DigestEqual,
} from '../../../src/ui/host/sessions.js';

import { cleanupTempDirs, makeWebBuild, rawRequest, type RawResponse } from './support.js';

const START = Date.parse('2026-11-11T10:00:00.000Z');

/** A clock the test advances by hand. */
class SteppedClock {
  public value = START;
  public readonly now = (): number => this.value;
  public advance(ms: number): void {
    this.value += ms;
  }
}

let clock: SteppedClock;
let store: SessionStore;

beforeEach(() => {
  clock = new SteppedClock();
  store = new SessionStore({ now: clock.now });
});

describe('launch codes', () => {
  it('issues a 256-bit base64url code valid for 60 seconds', () => {
    const issued = store.issueLaunchCode();
    expect(Buffer.from(issued.code, 'base64url')).toHaveLength(32);
    expect(issued.expiresAt).toBe(START + CODE_TTL_MS);
  });

  it('issues a different code each time', () => {
    expect(store.issueLaunchCode().code).not.toBe(store.issueLaunchCode().code);
  });

  it('works once; a second use is refused', () => {
    // Arrange
    const { code } = store.issueLaunchCode();

    // Act
    const first = store.exchange(code);
    const second = store.exchange(code);

    // Assert
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('works at exactly 60 seconds', () => {
    const { code } = store.issueLaunchCode();
    clock.advance(CODE_TTL_MS);
    expect(store.exchange(code)).not.toBeNull();
  });

  it('is refused at 60 seconds plus 1 ms', () => {
    const { code } = store.issueLaunchCode();
    clock.advance(CODE_TTL_MS + 1);
    expect(store.exchange(code)).toBeNull();
  });

  it.each([
    ['an unknown code', 'A'.repeat(43)],
    ['an empty string', ''],
    ['a number', 42],
    ['null', null],
    ['an oversize string', 'A'.repeat(10_000)],
  ])('refuses %s', (_label, code) => {
    expect(store.exchange(code)).toBeNull();
  });

  it('grants a new window with a 256-bit capability, a cookie and a 12-hour expiry', () => {
    const grant = store.exchange(store.issueLaunchCode().code);
    expect(grant).not.toBeNull();
    expect(Buffer.from(grant!.windowCapability, 'base64url')).toHaveLength(32);
    expect(Buffer.from(grant!.windowId, 'base64url')).toHaveLength(16);
    expect(grant!.cookie).not.toBe(grant!.windowCapability);
    expect(grant!.absoluteExpiry).toBe(START + ABSOLUTE_TTL_MS);
    expect(grant!.resumed).toBe(false);
  });
});

describe('capabilities', () => {
  it('authenticate with the matching cookie and capability', () => {
    const grant = store.exchange(store.issueLaunchCode().code)!;
    expect(store.authenticate(grant.cookie, grant.windowCapability)?.windowId).toBe(grant.windowId);
  });

  it('refuse a cookie presented without a capability', () => {
    const grant = store.exchange(store.issueLaunchCode().code)!;
    expect(store.authenticate(grant.cookie, undefined)).toBeNull();
    expect(store.authenticate(grant.cookie, '')).toBeNull();
  });

  it("refuse window A's cookie with window B's capability", () => {
    const a = store.exchange(store.issueLaunchCode().code)!;
    const b = store.exchange(store.issueLaunchCode().code)!;
    expect(store.authenticate(a.cookie, b.windowCapability)).toBeNull();
  });

  it('let two windows in one browser profile share the cookie, each with its own capability', () => {
    // Arrange: the second launch presents the first window's cookie.
    const a = store.exchange(store.issueLaunchCode().code)!;
    const b = store.exchange(store.issueLaunchCode().code, a.cookie)!;

    // Assert
    expect(b.cookie).toBe(a.cookie);
    expect(store.authenticate(a.cookie, a.windowCapability)?.windowId).toBe(a.windowId);
    expect(store.authenticate(a.cookie, b.windowCapability)?.windowId).toBe(b.windowId);
  });

  it('do not reuse a presented cookie that no live window owns', () => {
    const grant = store.exchange(store.issueLaunchCode().code, 'forged-cookie')!;
    expect(grant.cookie).not.toBe('forged-cookie');
  });

  it('expire 5 minutes after a window that never connected was created', () => {
    const grant = store.exchange(store.issueLaunchCode().code)!;
    clock.advance(DISCONNECT_GRACE_MS - 1);
    expect(store.liveWindow(grant.windowId)).not.toBeNull();
    clock.advance(1);
    expect(store.liveWindow(grant.windowId)).toBeNull();
  });

  it('expire exactly 5 minutes after the last socket closes', () => {
    // Arrange: two sockets open, then both close at different times.
    const grant = store.exchange(store.issueLaunchCode().code)!;
    store.socketOpened(grant.windowId);
    store.socketOpened(grant.windowId);
    clock.advance(60 * 60_000);
    store.socketClosed(grant.windowId);
    clock.advance(10 * 60_000); // one socket still open: no expiry
    expect(store.authenticate(grant.cookie, grant.windowCapability)).not.toBeNull();
    store.socketClosed(grant.windowId);

    // Act / Assert
    clock.advance(DISCONNECT_GRACE_MS - 1);
    expect(store.authenticate(grant.cookie, grant.windowCapability)).not.toBeNull();
    clock.advance(1);
    expect(store.authenticate(grant.cookie, grant.windowCapability)).toBeNull();
  });

  it('survive a reconnect within the grace period', () => {
    const grant = store.exchange(store.issueLaunchCode().code)!;
    store.socketOpened(grant.windowId);
    store.socketClosed(grant.windowId);
    clock.advance(DISCONNECT_GRACE_MS - 1);
    store.socketOpened(grant.windowId);
    clock.advance(DISCONNECT_GRACE_MS * 10);
    expect(store.authenticate(grant.cookie, grant.windowCapability)).not.toBeNull();
  });

  it('expire at 12 hours even while connected', () => {
    const grant = store.exchange(store.issueLaunchCode().code)!;
    store.socketOpened(grant.windowId);
    clock.advance(ABSOLUTE_TTL_MS - 1);
    expect(store.authenticate(grant.cookie, grant.windowCapability)).not.toBeNull();
    clock.advance(1);
    expect(store.authenticate(grant.cookie, grant.windowCapability)).toBeNull();
  });

  it('notify expiry listeners with the reason', () => {
    const expired: [string, string][] = [];
    store.onExpire((windowId, reason) => expired.push([windowId, reason]));
    const grant = store.exchange(store.issueLaunchCode().code)!;
    store.socketOpened(grant.windowId);
    clock.advance(ABSOLUTE_TTL_MS);
    expect(store.sweep()).toEqual([grant.windowId]);
    expect(expired).toEqual([[grant.windowId, 'absolute']]);
  });

  it('can be revoked', () => {
    const grant = store.exchange(store.issueLaunchCode().code)!;
    store.revoke(grant.windowId);
    expect(store.authenticate(grant.cookie, grant.windowCapability)).toBeNull();
    expect(store.cookieIsLive(grant.cookie)).toBe(false);
  });

  it('count connected windows only', () => {
    const a = store.exchange(store.issueLaunchCode().code)!;
    store.exchange(store.issueLaunchCode().code);
    store.socketOpened(a.windowId);
    expect(store.windowCount()).toBe(2);
    expect(store.connectedWindows().map((window) => window.windowId)).toEqual([a.windowId]);
  });
});

describe('resume codes', () => {
  it('give the same window a new capability and revoke the old one', () => {
    // Arrange
    const first = store.exchange(store.issueLaunchCode().code)!;
    const resume = store.issueResumeCode(first.windowId)!;

    // Act
    const second = store.exchange(resume.code, first.cookie)!;

    // Assert
    expect(second.windowId).toBe(first.windowId);
    expect(second.resumed).toBe(true);
    expect(second.windowCapability).not.toBe(first.windowCapability);
    expect(store.authenticate(first.cookie, first.windowCapability)).toBeNull();
    expect(store.authenticate(second.cookie, second.windowCapability)?.windowId).toBe(
      first.windowId,
    );
  });

  it('keep the original 12-hour expiry', () => {
    const first = store.exchange(store.issueLaunchCode().code)!;
    clock.advance(60_000);
    const second = store.exchange(store.issueResumeCode(first.windowId)!.code)!;
    expect(second.absoluteExpiry).toBe(first.absoluteExpiry);
  });

  it('are single use and valid for 60 seconds', () => {
    const first = store.exchange(store.issueLaunchCode().code)!;
    const resume = store.issueResumeCode(first.windowId)!;
    expect(resume.expiresAt).toBe(START + CODE_TTL_MS);
    expect(store.exchange(resume.code)).not.toBeNull();
    expect(store.exchange(resume.code)).toBeNull();
    const late = store.issueResumeCode(first.windowId)!;
    clock.advance(CODE_TTL_MS + 1);
    expect(store.exchange(late.code)).toBeNull();
  });

  it("cannot be used after window A's capability has expired", () => {
    // Arrange: the last socket closes; 30 s before the grace ends a resume code is issued.
    const a = store.exchange(store.issueLaunchCode().code)!;
    store.socketOpened(a.windowId);
    store.socketClosed(a.windowId);
    clock.advance(DISCONNECT_GRACE_MS - 30_000);
    const resume = store.issueResumeCode(a.windowId)!;

    // Act: 30 s later the window expires while the code is still inside its 60 s.
    clock.advance(30_000);

    // Assert
    expect(resume.expiresAt).toBeGreaterThan(clock.value);
    expect(store.exchange(resume.code)).toBeNull();
  });

  it('are refused for a window that already expired, even inside 60 seconds', () => {
    const a = store.exchange(store.issueLaunchCode().code)!;
    store.socketOpened(a.windowId);
    const resume = store.issueResumeCode(a.windowId)!;
    store.revoke(a.windowId);
    expect(store.exchange(resume.code)).toBeNull();
  });

  it('are not issued for an unknown or expired window', () => {
    expect(store.issueResumeCode('nope')).toBeNull();
    const a = store.exchange(store.issueLaunchCode().code)!;
    store.revoke(a.windowId);
    expect(store.issueResumeCode(a.windowId)).toBeNull();
  });
});

describe('constant-time comparison', () => {
  it('compares every digest through the injected constant-time function', () => {
    // Arrange
    const equal = vi.fn<DigestEqual>((left, right) => constantTimeEqual(left, right));
    const spied = new SessionStore({ now: clock.now, equal });
    const grant = spied.exchange(spied.issueLaunchCode().code)!;
    expect(equal).toHaveBeenCalled();
    equal.mockClear();

    // Act
    spied.authenticate(grant.cookie, grant.windowCapability);

    // Assert: one cookie and one capability comparison for the one window
    expect(equal).toHaveBeenCalledTimes(2);
  });

  it('uses crypto.timingSafeEqual by default', () => {
    const left = Buffer.from('abc');
    expect(constantTimeEqual(left, Buffer.from('abc'))).toBe(timingSafeEqual(left, left));
    expect(constantTimeEqual(left, Buffer.from('abcd'))).toBe(false);
  });
});

describe('cookie header', () => {
  it('has exactly HttpOnly, SameSite=Strict and Path=/, and no Secure', () => {
    expect(sessionCookieHeader('v')).toBe('yantra_session=v; HttpOnly; SameSite=Strict; Path=/');
  });

  it.each([
    ['a=1; yantra_session=abc; b=2', 'abc'],
    ['yantra_session=', null],
    ['other=1', null],
    [undefined, null],
  ])('reads %s', (cookie, expected) => {
    expect(readSessionCookie({ headers: cookie === undefined ? {} : { cookie } })).toBe(expected);
  });
});

describe('POST /session', () => {
  let host: AppHost;
  let port: number;

  beforeEach(async () => {
    host = new AppHost({
      assetsRoot: makeWebBuild(),
      routes: [sessionRoute(store, () => 'build-x')],
    });
    ({ port } = await host.start());
  });

  afterEach(async () => {
    await host.stop();
    cleanupTempDirs();
  });

  function post(body: string, headers: Record<string, string> = {}): Promise<RawResponse> {
    return rawRequest(port, {
      method: 'POST',
      path: '/session',
      headers: {
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'application/json',
        ...headers,
      },
      body,
    });
  }

  it('exchanges a launch code for the window session and sets the cookie', async () => {
    // Arrange
    const { code } = store.issueLaunchCode();

    // Act
    const response = await post(JSON.stringify({ code }));

    // Assert
    expect(response.status).toBe(200);
    const json = JSON.parse(response.body.toString()) as Record<string, string>;
    expect(Object.keys(json).sort()).toEqual([
      'absolute_expiry',
      'build_id',
      'window_capability',
      'window_id',
    ]);
    expect(json.build_id).toBe('build-x');
    expect(json.absolute_expiry).toBe(new Date(START + ABSOLUTE_TTL_MS).toISOString());
    const setCookie = response.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toMatch(
      /^yantra_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/,
    );
    expect(setCookie).not.toContain(json.window_capability);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('answers unknown, used and expired codes with byte-identical 401s', async () => {
    // Arrange
    const used = store.issueLaunchCode().code;
    await post(JSON.stringify({ code: used }));
    const expired = store.issueLaunchCode().code;
    clock.advance(CODE_TTL_MS + 1);

    // Act
    const responses = await Promise.all([
      post(JSON.stringify({ code: 'A'.repeat(43) })),
      post(JSON.stringify({ code: used })),
      post(JSON.stringify({ code: expired })),
      post('not json'),
      post('null'),
    ]);

    // Assert
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.body.toString()).toBe('{"error":"session_refused"}');
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    const bodies = new Set(responses.map((response) => response.body.toString('hex')));
    expect(bodies.size).toBe(1);
  });

  it('requires the exact Origin (a cross-site form POST is refused)', async () => {
    const { code } = store.issueLaunchCode();
    const response = await rawRequest(port, {
      method: 'POST',
      path: '/session',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `code=${code}`,
    });
    expect(response.status).toBe(403);
    expect(store.exchange(code)).not.toBeNull(); // the refused attempt did not spend it
  });

  it('refuses GET /session without exchanging anything', async () => {
    const response = await rawRequest(port, { path: '/session' });
    expect(response.status).toBe(401);
  });

  it('keeps the presented live cookie for a second window', async () => {
    const first = await post(JSON.stringify({ code: store.issueLaunchCode().code }));
    const cookie = (first.headers['set-cookie']?.[0] ?? '').split(';', 1)[0] ?? '';
    const second = await post(JSON.stringify({ code: store.issueLaunchCode().code }), { cookie });
    expect((second.headers['set-cookie']?.[0] ?? '').split(';', 1)[0]).toBe(cookie);
  });
});
