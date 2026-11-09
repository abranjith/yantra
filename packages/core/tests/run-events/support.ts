import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunEventType } from '@yantra/protocol';

import type { RunEventLogScheduler } from '../../src/run-events/log.js';
import { readRunEvents } from '../../src/run-events/reader.js';

export const AT = '2026-11-01T12:00:00.000Z';
export const CONFIRMATION_ID = '01J00000000000000000000000';

const dirs: string[] = [];

/** A fresh, empty run directory, removed by {@link cleanupRunDirs}. */
export async function makeRunDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yantra-run-events-'));
  dirs.push(dir);
  return dir;
}

export async function cleanupRunDirs(): Promise<void> {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export function taskStarted(taskId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'): RunEventType {
  return { kind: 'task_started', task_id: taskId, at: AT };
}

export function assistantText(text: string): RunEventType {
  return { kind: 'assistant_text', text, at: AT };
}

export function runOutcome(exitCode = 0): RunEventType {
  return {
    kind: 'run_outcome',
    run_id: 'run-1',
    task_outcome: exitCode === 0 ? 'fulfilled' : 'failed',
    termination_reason: null,
    stop_detail: null,
    exit_code: exitCode,
    failure_class: exitCode === 0 ? null : 'unexpected',
    at: AT,
  };
}

export const consentRequest = {
  confirmation_id: CONFIRMATION_ID,
  run_id: 'run-1',
  step_id: 'step-1',
  action_kind: 'click',
  host: 'shop.example',
  description: 'Place the order',
  expected_cost: null,
  consequence: 'irreversible',
  requested_at: AT,
  timeout_ms: 1000,
} as const;

export function interventionRaised(): RunEventType {
  return {
    kind: 'intervention_raised',
    intervention_id: CONFIRMATION_ID,
    intervention_kind: 'confirmation',
    request: consentRequest,
    deadline_at: null,
    at: AT,
  };
}

/** A timer seam the test fires by hand. */
export class ManualScheduler implements RunEventLogScheduler {
  public readonly pending: { readonly callback: () => void; readonly ms: number }[] = [];

  public setTimeout(callback: () => void, ms: number): unknown {
    const handle = { callback, ms };
    this.pending.push(handle);
    return handle;
  }

  public clearTimeout(handle: unknown): void {
    const index = this.pending.indexOf(handle as (typeof this.pending)[number]);
    if (index !== -1) this.pending.splice(index, 1);
  }

  /** Runs every pending timer, as if its delay elapsed. */
  public elapse(): void {
    for (const handle of this.pending.splice(0)) handle.callback();
  }
}

/** Every item the reader yields. */
export async function readAll(path: string, fromSeq?: number): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const item of readRunEvents(path, fromSeq === undefined ? {} : { fromSeq })) {
    items.push(item);
  }
  return items;
}

/** The `seq` of every `event` item the reader yields. */
export async function readSeqs(path: string): Promise<number[]> {
  const seqs: number[] = [];
  for await (const item of readRunEvents(path)) {
    if (item.status === 'event') seqs.push(item.record.seq);
  }
  return seqs;
}

export const silentLogger = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
  debug: (): void => undefined,
};
