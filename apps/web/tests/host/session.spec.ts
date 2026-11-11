// @no-llm
/**
 * Launch codes, the session exchange and resume codes in the page
 * (FEAT-065 TASK-011).
 */

import { APP_CHANNEL_VERSION } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PAGE_CHANNEL_VERSION } from '../../src/app/bootstrap.js';
import { ConnectionStore } from '../../src/host/connection-store.js';
import {
  RESUME_CODE_KEY,
  RESUME_ROTATE_MS,
  SessionClient,
  startResumeRotation,
  type FetchLike,
} from '../../src/host/session.js';
import { FakeSocket, HELLO, flush } from '../support/fake-socket.js';

const CODE = 'L'.repeat(43);
const GRANT = {
  window_id: 'win-1',
  window_capability: 'CAPABILITY-CANARY-0123456789',
  build_id: 'b',
  absolute_expiry: '2026-11-11T22:00:00.000Z',
};

function okFetch(body: unknown = GRANT) {
  return vi.fn<FetchLike>(() => Promise.resolve({ ok: true, json: () => Promise.resolve(body) }));
}

describe('take-launch-code', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('removes the code from the URL at import and hands it out once', async () => {
    // Arrange
    window.history.replaceState(null, '', `/runs?x=1#code=${CODE}`);

    // Act
    const boot = await import('../../src/boot/take-launch-code.js');

    // Assert
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/runs');
    expect(window.location.search).toBe('?x=1');
    expect(boot.takeLaunchCode()).toBe(CODE);
    expect(boot.takeLaunchCode()).toBeNull();
  });

  it('ignores a malformed code but still scrubs the fragment', async () => {
    window.history.replaceState(null, '', '/#code=<script>');
    const boot = await import('../../src/boot/take-launch-code.js');
    expect(window.location.hash).toBe('');
    expect(boot.takeLaunchCode()).toBeNull();
  });

  it('removes the code from the URL before the session exchange begins', async () => {
    // Arrange: the URL carries a code; fetch records what the URL was when called.
    window.history.replaceState(null, '', `/#code=${CODE}`);
    const urlsAtFetch: string[] = [];
    const fetchSpy = vi.fn<FetchLike>(() => {
      urlsAtFetch.push(window.location.href);
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchSpy);

    // Act: bootstrap imports take-launch-code first, then exchanges.
    const { bootstrap } = await import('../../src/app/bootstrap.js');
    await bootstrap(new ConnectionStore());

    // Assert
    expect(fetchSpy).toHaveBeenCalled();
    expect(urlsAtFetch.every((url) => !url.includes(CODE) && !url.includes('#code'))).toBe(true);
    const sentBody = String(fetchSpy.mock.calls[0]?.[1].body);
    expect(sentBody).toBe(JSON.stringify({ code: CODE }));
    vi.unstubAllGlobals();
  });
});

describe('SessionClient', () => {
  it('exchanges a launch code with a same-origin, uncached POST', async () => {
    const fetch = okFetch();
    const session = new SessionClient({ fetch, storage: window.sessionStorage });
    expect(await session.open(CODE)).toBe(true);
    expect(fetch).toHaveBeenCalledWith('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: CODE }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    expect(session.capability()).toBe(GRANT.window_capability);
    expect(session.grant()).toEqual({
      window_id: 'win-1',
      build_id: 'b',
      absolute_expiry: GRANT.absolute_expiry,
    });
  });

  it('falls back to a stored resume code and removes it before using it', async () => {
    // Arrange
    window.sessionStorage.setItem(RESUME_CODE_KEY, 'R'.repeat(43));
    const fetch = vi.fn<FetchLike>(() => {
      expect(window.sessionStorage.getItem(RESUME_CODE_KEY)).toBeNull();
      return Promise.resolve({ ok: true, json: () => Promise.resolve(GRANT) });
    });

    // Act
    const opened = await new SessionClient({ fetch, storage: window.sessionStorage }).open(null);

    // Assert
    expect(opened).toBe(true);
    expect(String(fetch.mock.calls[0]?.[1].body)).toContain('R'.repeat(43));
    expect(window.sessionStorage.getItem(RESUME_CODE_KEY)).toBeNull();
  });

  it('removes a used resume code even when the exchange fails', async () => {
    window.sessionStorage.setItem(RESUME_CODE_KEY, 'R'.repeat(43));
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    );
    expect(await new SessionClient({ fetch, storage: window.sessionStorage }).open(null)).toBe(
      false,
    );
    expect(window.sessionStorage.getItem(RESUME_CODE_KEY)).toBeNull();
  });

  it('reports failure with neither a launch nor a resume code', async () => {
    const fetch = okFetch();
    expect(await new SessionClient({ fetch, storage: window.sessionStorage }).open(null)).toBe(
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a malformed grant', async () => {
    const session = new SessionClient({ fetch: okFetch({ window_id: 'x' }), storage: null });
    expect(await session.open(CODE)).toBe(false);
    expect(session.capability()).toBeNull();
  });

  it('survives storage that throws', async () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    const session = new SessionClient({ fetch: okFetch(), storage: throwing });
    expect(await session.open(null)).toBe(false);
    expect(() => {
      session.storeResumeCode('x');
    }).not.toThrow();
  });
});

describe('resume rotation', () => {
  it('stores a fresh resume code now and every 45 seconds while connected', async () => {
    // Arrange
    const codes = ['c1', 'c2'];
    const rpc = {
      connected: true,
      request: vi.fn(() => Promise.resolve({ code: codes.shift() })),
    };
    let tick: (() => void) | undefined;
    const session = new SessionClient({ fetch: okFetch(), storage: window.sessionStorage });

    // Act
    const rotation = startResumeRotation(rpc as never, session, {
      setInterval: (callback, ms) => {
        expect(ms).toBe(RESUME_ROTATE_MS);
        tick = callback;
        return 1;
      },
      clearInterval: () => undefined,
    });
    await flush();
    const first = window.sessionStorage.getItem(RESUME_CODE_KEY);
    tick?.();
    await flush();

    // Assert
    expect(first).toBe('c1');
    expect(window.sessionStorage.getItem(RESUME_CODE_KEY)).toBe('c2');
    expect(rpc.request).toHaveBeenCalledWith('session.resume_code');
    rotation.stop();
  });

  it('does nothing while disconnected', () => {
    const rpc = { connected: false, request: vi.fn() };
    startResumeRotation(rpc as never, new SessionClient({ fetch: okFetch(), storage: null }), {
      setInterval: () => 1,
      clearInterval: () => undefined,
    }).rotate();
    expect(rpc.request).not.toHaveBeenCalled();
  });
});

describe('the capability', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('never reaches localStorage, sessionStorage, the URL or document.cookie', async () => {
    // Arrange: a launch, a socket that connects and rotates a resume code.
    window.history.replaceState(null, '', `/#code=${CODE}`);
    vi.stubGlobal('fetch', okFetch());
    const sockets: FakeSocket[] = [];
    vi.stubGlobal(
      'WebSocket',
      class extends FakeSocket {
        public constructor(url: string) {
          super(url);
          sockets.push(this);
        }
      },
    );
    const { bootstrap } = await import('../../src/app/bootstrap.js');

    // Act
    const app = await bootstrap(new ConnectionStore());
    const socket = sockets[0]!;
    socket.open();
    socket.answer('host.hello', HELLO);
    await flush();
    socket.answer('session.resume_code', { code: 'RESUME-ONLY' });
    await flush();

    // Assert
    expect(app).not.toBeNull();
    const canary = GRANT.window_capability;
    const local = JSON.stringify({ ...window.localStorage });
    const session = JSON.stringify({ ...window.sessionStorage });
    expect(local).not.toContain(canary);
    expect(session).not.toContain(canary);
    expect(session).toContain('RESUME-ONLY');
    expect(window.location.href).not.toContain(canary);
    expect(document.cookie).not.toContain(canary);
    expect(socket.url).not.toContain(canary);
    expect(socket.sent[0]).toEqual({
      jsonrpc: '2.0',
      method: 'auth',
      params: { window_capability: canary },
    });
    app?.rpc.close();
  });
});

describe('channel version', () => {
  it('matches the protocol', () => {
    expect(PAGE_CHANNEL_VERSION).toBe(APP_CHANNEL_VERSION);
  });
});
