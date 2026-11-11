import { join } from 'node:path';

import type { RunChannelEventPayload, RunEventReadItem } from '@yantra/protocol';

import { RUN_EVENTS_FILENAME } from '../run-events/log.js';
import { readRunEvents } from '../run-events/reader.js';
import type { RunEventStream } from '../run-events/stream.js';

/** One committed event, as the run socket forwards it. */
export interface CommittedEvent {
  readonly seq: number;
  readonly event: RunChannelEventPayload;
}

/**
 * What the run socket needs from a run's event log (FEAT-063): committed
 * events as they happen, the watermark, and a range reader over the file.
 * Every call happens on the owner's event loop.
 */
export interface RunEventSource {
  /** `seq` of the last committed event (the replay watermark). */
  readonly lastSeq: number;
  /** Receives every event once it is committed (persist before publish). */
  subscribe(listener: (event: CommittedEvent) => void): () => void;
  /** Reads committed events from the file, from `fromSeq`; a partial tail is never yielded. */
  read(fromSeq: number): AsyncIterable<CommittedEvent>;
}

/** A file item as a deliverable event, or null for an invalid line. */
export function committedFromItem(item: RunEventReadItem): CommittedEvent | null {
  if (item.status === 'event') return { seq: item.record.seq, event: item.record.event };
  if (item.status === 'unknown_kind') {
    return { seq: item.seq, event: item.raw as RunChannelEventPayload };
  }
  return null;
}

/** Reads a run's `run-events.jsonl` from `fromSeq` as committed events. */
export async function* readCommittedEvents(
  runDir: string,
  fromSeq: number,
): AsyncGenerator<CommittedEvent> {
  for await (const item of readRunEvents(join(runDir, RUN_EVENTS_FILENAME), { fromSeq })) {
    const event = committedFromItem(item);
    if (event !== null) yield event;
  }
}

/** Adapts a run's open {@link RunEventStream} to the run socket. */
export function streamEventSource(stream: RunEventStream, runDir: string): RunEventSource {
  return {
    get lastSeq() {
      return stream.lastSeq;
    },
    subscribe: (listener) =>
      stream.subscribe((delivery) => {
        if (delivery.committed && delivery.seq !== null) {
          listener({ seq: delivery.seq, event: delivery.event });
        }
      }),
    read: (fromSeq) => readCommittedEvents(runDir, fromSeq),
  };
}
