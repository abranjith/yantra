/**
 * The app's RPC handle for React (FEAT-066).
 *
 * Pages read through {@link useRpc}. `main.tsx` provides a
 * {@link DeferredRpc}: it exists before the session opens, and each request
 * waits until the socket is connected, so a page can mount and query at once.
 * Tests provide a fake {@link AppRpc}.
 */

import { createContext, useContext, type ReactNode } from 'react';

import type { ConnectionStore } from './connection-store.js';
import type { RpcClient } from './rpc-client.js';

/** What pages need from the host connection. */
export interface AppRpc {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Handles a notification; returns the unsubscribe function. */
  on(method: string, handler: (params: Record<string, unknown>) => void): () => void;
  /** Subscribes now and after every reconnect (e.g. `runs.subscribe`). */
  subscribe(method: string, params?: Record<string, unknown>): void;
}

/** An {@link AppRpc} over a client that is attached once the session opens. */
export class DeferredRpc implements AppRpc {
  private client: RpcClient | null = null;
  private readonly pendingHandlers: {
    method: string;
    handler: (params: Record<string, unknown>) => void;
    off: (() => void) | null;
  }[] = [];
  private readonly pendingSubscriptions: { method: string; params: Record<string, unknown> }[] = [];
  private readonly waiters: (() => void)[] = [];

  public constructor(private readonly store: ConnectionStore) {
    store.subscribe(() => {
      if (store.getSnapshot().status === 'connected') this.release();
    });
  }

  /** Attaches the live client (once, from `bootstrap`). */
  public attach(client: RpcClient): void {
    this.client = client;
    for (const entry of this.pendingHandlers) entry.off = client.on(entry.method, entry.handler);
    for (const { method, params } of this.pendingSubscriptions.splice(0)) {
      client.subscribe(method, params);
    }
    if (this.store.getSnapshot().status === 'connected') this.release();
  }

  public async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.ready();
    return this.client!.request<T>(method, params);
  }

  public on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    if (this.client !== null) return this.client.on(method, handler);
    const entry = { method, handler, off: null as (() => void) | null };
    this.pendingHandlers.push(entry);
    return () => {
      entry.off?.();
      const index = this.pendingHandlers.indexOf(entry);
      if (index >= 0) this.pendingHandlers.splice(index, 1);
    };
  }

  public subscribe(method: string, params: Record<string, unknown> = {}): void {
    if (this.client !== null) this.client.subscribe(method, params);
    else this.pendingSubscriptions.push({ method, params });
  }

  private ready(): Promise<void> {
    if (this.client?.connected === true) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    if (this.client?.connected !== true) return;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

const RpcContext = createContext<AppRpc | null>(null);

/** Provides the RPC handle to the page tree. */
export function RpcProvider({
  rpc,
  children,
}: {
  readonly rpc: AppRpc;
  readonly children: ReactNode;
}): ReactNode {
  return <RpcContext.Provider value={rpc}>{children}</RpcContext.Provider>;
}

/** The RPC handle; throws outside {@link RpcProvider} (a wiring bug). */
export function useRpc(): AppRpc {
  const rpc = useContext(RpcContext);
  if (rpc === null) throw new Error('useRpc() needs an <RpcProvider> above it.');
  return rpc;
}
