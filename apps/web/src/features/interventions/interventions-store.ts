import type { DecisionResponse, InboxItem } from '@yantra/protocol';
import { useSyncExternalStore } from 'react';

import type { AppRpc } from '../../host/app-rpc.js';

export interface InterventionSnapshot {
  readonly items: readonly InboxItem[];
  readonly count: number;
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY: InterventionSnapshot = Object.freeze({
  items: [],
  count: 0,
  loading: true,
  error: null,
});

export class InterventionsStore {
  private snapshot: InterventionSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private offEvent: (() => void) | null = null;

  public constructor(private readonly rpc: AppRpc) {}

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public getSnapshot = (): InterventionSnapshot => this.snapshot;

  public start(): () => void {
    this.rpc.subscribe('interventions.subscribe');
    this.offEvent = this.rpc.on('intervention.event', () => void this.refresh());
    this.heartbeat = setInterval(() => {
      void this.rpc.request('attendance.heartbeat').catch(() => undefined);
    }, 10_000);
    void this.refresh();
    return () => this.stop();
  }

  public stop(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.offEvent?.();
    this.offEvent = null;
  }

  public async refresh(): Promise<void> {
    this.set({ loading: true, error: null });
    try {
      const result = await this.rpc.request<{ items: InboxItem[]; count: number }>('inbox.list', {
        limit: 200,
      });
      this.set({ items: result.items, count: result.count, loading: false, error: null });
    } catch (error) {
      this.set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  public async answer(item: InboxItem, decision: 'granted' | 'denied'): Promise<DecisionResponse> {
    const response = await this.rpc.request<DecisionResponse>('intervention.answer', {
      run_id: item.run_id,
      intervention_id: item.intervention?.intervention_id,
      decision,
    });
    await this.refresh();
    return response;
  }

  public async dismiss(itemId: string): Promise<void> {
    await this.rpc.request('inbox.dismiss', { item_id: itemId });
    await this.refresh();
  }

  private set(next: Partial<InterventionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }
}

export function useInterventionsStore(store: InterventionsStore): InterventionSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
