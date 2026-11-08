/**
 * `MirroringEventBus` (FEAT-063): every `TaskEvent` a run publishes still goes
 * to `events.jsonl` exactly as before, and is mirrored into the run's
 * `RunEventStream`, so `run-events.jsonl` holds the same lifecycle events in
 * order with everything else the run did.
 */

import { join } from 'node:path';

import type { TaskEvent } from '@yantra/protocol';

import { JsonlEventBus } from '../executor/event-bus.js';
import type { EventBus } from '../executor/types.js';

import type { RunEventStream } from './stream.js';

export class MirroringEventBus implements EventBus {
  private closed = false;

  public constructor(
    private readonly inner: EventBus,
    private readonly stream: RunEventStream,
  ) {}

  /** Publishes to `events.jsonl` and mirrors into the stream; dropped after close, as before. */
  public publish(event: TaskEvent): void {
    if (this.closed) return;
    this.inner.publish(event);
    this.stream.emit(event);
  }

  public flush(): Promise<void> {
    return this.inner.flush();
  }

  public persistedAt(): string {
    return this.inner.persistedAt();
  }

  /** Closes `events.jsonl` only: the stream outlives the bus (the outcome follows). */
  public close(): Promise<void> {
    this.closed = true;
    return this.inner.close();
  }
}

/**
 * The run's task-event bus: `events.jsonl`, mirrored into `stream` when one
 * is given. Replaces every direct `new JsonlEventBus(join(runDir, 'events.jsonl'))`.
 */
export function openTaskEventBus(
  runDir: string,
  stream: RunEventStream | null | undefined,
): EventBus {
  const inner = new JsonlEventBus(join(runDir, 'events.jsonl'));
  return stream ? new MirroringEventBus(inner, stream) : inner;
}
