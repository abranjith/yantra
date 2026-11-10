/**
 * Per-connection outbound queues for the run socket (FEAT-064 TASK-007).
 *
 * - **Event queue**: control and event JSON frames, FIFO, bounded by encoded
 *   bytes. Overflow drops *this* connection only; its client reconnects and
 *   replays from the file, so nothing is lost.
 * - **Frame slot**: one screencast frame; a newer one replaces an unsent one.
 * - **Writer**: always drains the event queue before the frame slot, and
 *   honors `write()` returning false by waiting for `drain`.
 *
 * `enqueue` and `offerFrame` are synchronous and never wait, so a slow socket
 * can never block the owner's event loop or another client.
 */

import { OUTBOUND_EVENT_QUEUE_BYTES } from '../run-ownership/constants.js';

/** The part of a socket the writer uses. */
export interface OutboundSink {
  write(chunk: Buffer): boolean;
  once(event: 'drain' | 'close', listener: () => void): unknown;
  readonly destroyed: boolean;
}

export interface OutboundQueuesOptions {
  /** Encoded bytes the event queue may hold; replay frames are not counted. */
  readonly maxEventBytes?: number;
  /** Called once, synchronously, when an enqueue would exceed the bound. */
  readonly onOverflow: () => void;
}

interface QueuedFrame {
  readonly bytes: Buffer;
  /** Replay frames are paced by their own writes, not bounded. */
  readonly counted: boolean;
  readonly written?: () => void;
}

export class OutboundQueues {
  private readonly events: QueuedFrame[] = [];
  private head = 0;
  private slot: Buffer | null = null;
  private queuedBytes = 0;
  private waitingForDrain = false;
  private overflowed = false;
  private stopped = false;
  private whenIdle: (() => void) | null = null;
  private readonly maxEventBytes: number;
  /** Screencast frames replaced before they were written. */
  public droppedFrames = 0;

  public constructor(
    private readonly sink: OutboundSink,
    private readonly options: OutboundQueuesOptions,
  ) {
    this.maxEventBytes = options.maxEventBytes ?? OUTBOUND_EVENT_QUEUE_BYTES;
    sink.once('close', () => {
      this.stop();
    });
  }

  /** Encoded bytes waiting in the event queue (replay frames excluded). */
  public get eventBytes(): number {
    return this.queuedBytes;
  }

  /** True after an overflow or once the sink closed. */
  public get closed(): boolean {
    return this.stopped || this.overflowed;
  }

  /**
   * Queues a control or event frame. Returns false, and reports overflow
   * once, when it would push the queue past its bound.
   */
  public enqueue(bytes: Buffer): boolean {
    if (this.closed) return false;
    if (this.queuedBytes + bytes.length > this.maxEventBytes) {
      this.overflowed = true;
      this.options.onOverflow();
      return false;
    }
    this.events.push({ bytes, counted: true });
    this.queuedBytes += bytes.length;
    this.pump();
    return true;
  }

  /**
   * Queues a replayed event and resolves once it is handed to the socket, so
   * a replay is paced by the socket rather than buffered. Not counted against
   * the bound.
   */
  public enqueueReplay(bytes: Buffer): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.events.push({ bytes, counted: false, written: resolve });
      this.pump();
    });
  }

  /** Offers a screencast frame; it replaces an unsent one. */
  public offerFrame(bytes: Buffer): void {
    if (this.closed) return;
    if (this.slot !== null) this.droppedFrames += 1;
    this.slot = bytes;
    this.pump();
  }

  /**
   * Calls `callback` once every queued event has been handed to the socket
   * (an unsent screencast frame is dropped), for a graceful end.
   */
  public drainThen(callback: () => void): void {
    if (this.closed) {
      callback();
      return;
    }
    this.slot = null;
    this.whenIdle = callback;
    this.pump();
  }

  private pump(): void {
    while (!this.closed && !this.sink.destroyed) {
      if (this.head >= this.events.length && this.slot === null) {
        // Everything is handed to the socket, which flushes its own buffer
        // before a graceful end, so a pending end need not wait for drain.
        const idle = this.whenIdle;
        this.whenIdle = null;
        idle?.();
        return;
      }
      if (this.waitingForDrain) return;
      const next = this.takeNext();
      if (next === null) return;
      const accepted = this.sink.write(next.bytes);
      next.written?.();
      if (!accepted) {
        this.waitingForDrain = true;
        this.sink.once('drain', () => {
          this.waitingForDrain = false;
          this.pump();
        });
      }
    }
  }

  private takeNext(): QueuedFrame | null {
    const next = this.events[this.head];
    if (next !== undefined) {
      this.head += 1;
      if (this.head > 1024 && this.head * 2 > this.events.length) {
        this.events.splice(0, this.head);
        this.head = 0;
      }
      if (next.counted) this.queuedBytes -= next.bytes.length;
      return next;
    }
    if (this.slot !== null) {
      const bytes = this.slot;
      this.slot = null;
      return { bytes, counted: false };
    }
    return null;
  }

  private stop(): void {
    this.stopped = true;
    // Release any replay waiting on a write that will never happen.
    for (let index = this.head; index < this.events.length; index += 1) {
      this.events[index]?.written?.();
    }
    this.events.length = 0;
    this.head = 0;
    this.queuedBytes = 0;
    this.slot = null;
  }
}
