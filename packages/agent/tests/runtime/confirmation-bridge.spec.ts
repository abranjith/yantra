import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfirmationStore } from '@yantra/core';
import type { ConfirmationRequest } from '@yantra/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfirmationBridge,
  type ConfirmationWaitAbortedError,
  type ConfirmationConnector,
} from '../../src/runtime/confirmation-bridge.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function request(timeoutMs = 100): ConfirmationRequest {
  return {
    confirmation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    run_id: 'run-1',
    step_id: 'browser_click:1',
    action_kind: 'click',
    host: 'example.com',
    description: 'Submit the fixture form',
    expected_cost: null,
    consequence: 'hard_to_reverse',
    requested_at: '2026-07-14T12:00:00.000Z',
    timeout_ms: timeoutMs,
  };
}

async function store(): Promise<ConfirmationStore> {
  const dir = await mkdtemp(join(tmpdir(), 'yantra-confirmation-'));
  tempDirs.push(dir);
  return new ConfirmationStore(join(dir, 'confirmations.jsonl'));
}

function bridge(options: {
  readonly response?: 'granted' | 'denied' | 'pending';
  readonly interactive?: boolean;
  readonly timeoutMs?: number;
  readonly remainingMs?: number;
  readonly runSignal?: AbortSignal;
  readonly store?: ConfirmationStore;
}): { bridge: ConfirmationBridge; connector: ConfirmationConnector } {
  const connector: ConfirmationConnector = {
    interactive: options.interactive ?? true,
    requestConfirmation: vi.fn((_request, signal) => {
      if (options.response !== 'pending') return Promise.resolve(options.response ?? 'granted');
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('connector canceled')), {
          once: true,
        });
      });
    }),
  };
  return {
    connector,
    bridge: new ConfirmationBridge({
      connector,
      timeoutMs: options.timeoutMs ?? 50,
      runSignal: options.runSignal ?? new AbortController().signal,
      remainingWallClockMs: () => options.remainingMs ?? 1_000,
      store: options.store ?? null,
      nowIso: () => '2026-07-14T12:00:01.000Z',
    }),
  };
}

describe('@no-llm ConfirmationBridge', () => {
  it.each([
    ['granted', 'granted'],
    ['denied', 'denied'],
  ] as const)(
    'records an explicit %s decision with request linkage',
    async (response, expected) => {
      const audit = await store();
      const fixture = bridge({ response, store: audit });

      const decision = await fixture.bridge.request(request());
      const entries = await audit.readAll();

      expect(decision).toMatchObject({
        confirmation_id: request().confirmation_id,
        decision: expected,
        decided_by: 'user_interactive',
      });
      expect(entries.map((entry) => entry.kind)).toEqual(['request', 'decision']);
    },
  );

  it('times out fail-closed, cancels the connector wait, and records timed_out', async () => {
    const audit = await store();
    const fixture = bridge({
      response: 'pending',
      timeoutMs: 10,
      remainingMs: 1_000,
      store: audit,
    });

    const decision = await fixture.bridge.request(request(10));

    expect(decision).toMatchObject({ decision: 'timed_out', decided_by: 'timeout' });
    expect((await audit.readAll()).map((entry) => entry.kind)).toEqual(['request', 'decision']);
  });

  it('cancels a pending wait and propagates run abort for teardown', async () => {
    const controller = new AbortController();
    const fixture = bridge({ response: 'pending', runSignal: controller.signal });

    const pending = fixture.bridge.request(request());
    controller.abort('user-interrupt');

    await expect(pending).rejects.toEqual(expect.objectContaining({ code: 'AGENT_ABORTED' }));
  });

  it('lets wall-clock budget expiry win over confirmation timeout', async () => {
    const fixture = bridge({ response: 'pending', timeoutMs: 100, remainingMs: 5 });

    await expect(fixture.bridge.request(request(100))).rejects.toEqual(
      expect.objectContaining<Partial<ConfirmationWaitAbortedError>>({
        code: 'AGENT_BUDGET_EXHAUSTED',
        reason: 'wall-clock',
      }),
    );
  });

  it('denies immediately without presenting a prompt on a non-interactive connector', async () => {
    const fixture = bridge({ interactive: false, response: 'granted' });

    const decision = await fixture.bridge.request(request());

    expect(decision).toMatchObject({ decision: 'timed_out', decided_by: 'timeout' });
    expect(fixture.connector.requestConfirmation).not.toHaveBeenCalled();
  });
});
