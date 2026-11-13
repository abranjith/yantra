/**
 * A fake host connection for route tests (FEAT-066): answers requests from
 * per-method responders, records every call, and can push notifications.
 * Mocks stop at this boundary; everything above it is the real app.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, render, type RenderResult } from '@testing-library/react';

import { makeRouter } from '../../src/app/router.js';
import { RpcProvider, type AppRpc } from '../../src/host/app-rpc.js';
import { connectionStore } from '../../src/host/connection-store.js';

export type Responder = (params: Record<string, unknown>) => unknown;

/** One recorded request. */
export interface RecordedCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** See the module comment. */
export class FakeRpc implements AppRpc {
  public readonly calls: RecordedCall[] = [];
  public readonly subscriptions: string[] = [];
  private readonly responders = new Map<string, Responder>();
  private readonly handlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  /** Answers `method` with `responder` (a value, or a function of the params). */
  public answer(method: string, responder: Responder | object): this {
    this.responders.set(
      method,
      typeof responder === 'function' ? (responder as Responder) : () => responder,
    );
    return this;
  }

  public request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const responder = this.responders.get(method);
    if (responder === undefined) return Promise.reject(new Error(`No answer for ${method}`));
    try {
      return Promise.resolve(responder(params) as T);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  public on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    let set = this.handlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  public subscribe(method: string): void {
    this.subscriptions.push(method);
  }

  /** Delivers a host notification to every handler. */
  public notify(method: string, params: Record<string, unknown>): void {
    for (const handler of [...(this.handlers.get(method) ?? [])]) handler(params);
  }

  /** The params of every call to `method`, in order. */
  public paramsOf(method: string): Record<string, unknown>[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }
}

/** Renders the real router at `path` over `rpc`; resolves once the route has loaded. */
export async function renderAt(
  path: string,
  rpc: AppRpc,
): Promise<RenderResult & { router: ReturnType<typeof makeRouter> }> {
  connectionStore.set({ status: 'connected' });
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const result = render(
    <RpcProvider rpc={rpc}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </RpcProvider>,
  );
  await act(async () => {
    await router.load();
  });
  return Object.assign(result, { router });
}
