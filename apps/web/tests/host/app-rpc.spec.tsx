// @no-llm
/**
 * The deferred RPC handle (FEAT-066): requests wait for the connection,
 * handlers and subscriptions registered early reach the client once attached,
 * and `useRpc` requires a provider.
 */

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DeferredRpc, useRpc } from '../../src/host/app-rpc.js';
import { ConnectionStore } from '../../src/host/connection-store.js';
import type { RpcClient } from '../../src/host/rpc-client.js';

function fakeClient(connected: boolean) {
  const client = {
    connected,
    request: vi.fn(() => Promise.resolve('answer')),
    on: vi.fn(() => () => undefined),
    subscribe: vi.fn(),
  };
  return client as typeof client & RpcClient;
}

describe('DeferredRpc', () => {
  it('holds a request until the client is attached and connected', async () => {
    const store = new ConnectionStore();
    const rpc = new DeferredRpc(store);
    const client = fakeClient(false);

    const pending = rpc.request('read.list', { limit: 1 });
    rpc.attach(client);
    expect(client.request).not.toHaveBeenCalled();
    client.connected = true;
    store.set({ status: 'connected' });

    await expect(pending).resolves.toBe('answer');
    expect(client.request).toHaveBeenCalledWith('read.list', { limit: 1 });
  });

  it('sends at once when the client is already connected', async () => {
    const store = new ConnectionStore();
    const rpc = new DeferredRpc(store);
    const client = fakeClient(true);
    store.set({ status: 'connected' });
    rpc.attach(client);

    await expect(rpc.request('host.hello')).resolves.toBe('answer');
  });

  it('passes early handlers and subscriptions to the client on attach', () => {
    const rpc = new DeferredRpc(new ConnectionStore());
    const handler = vi.fn();
    rpc.on('runs.changed', handler);
    rpc.subscribe('runs.subscribe');
    const client = fakeClient(false);

    rpc.attach(client);

    expect(client.on).toHaveBeenCalledWith('runs.changed', handler);
    expect(client.subscribe).toHaveBeenCalledWith('runs.subscribe', {});
  });

  it('forgets an early handler that unsubscribes before attach', () => {
    const rpc = new DeferredRpc(new ConnectionStore());
    const off = rpc.on('runs.changed', vi.fn());
    off();
    const client = fakeClient(false);
    rpc.attach(client);
    expect(client.on).not.toHaveBeenCalled();
  });
});

describe('useRpc', () => {
  it('throws outside a provider', () => {
    function Probe() {
      useRpc();
      return null;
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/RpcProvider/u);
  });
});
