import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { TaskEvent } from '@yantra/protocol';

import type { EventBus } from './types.js';

const FLUSH_DEBOUNCE_MS = 200;

/**
 * In-process pub/sub event bus backed by an append-only JSONL file.
 *
 * Events are written to an in-memory buffer and flushed every 200ms (debounced).
 * `flush()` forces an immediate synchronous-ish write — always called before
 * writing checkpoints so the event log stays ahead of the durable state.
 */
export class JsonlEventBus implements EventBus {
  private readonly buffer: TaskEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private fileHandle: Awaited<ReturnType<typeof open>> | null = null;
  private opening: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly filePath: string) {}

  publish(event: TaskEvent): void {
    if (this.closed) return;
    this.buffer.push(event);
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.drainBuffer();
  }

  persistedAt(): string {
    return this.filePath;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
    await this.fileHandle?.close().catch(() => {});
    this.fileHandle = null;
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.drainBuffer();
    }, FLUSH_DEBOUNCE_MS);
    if (typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
  }

  private async ensureOpen(): Promise<void> {
    if (this.fileHandle !== null) return;
    if (this.opening !== null) {
      await this.opening;
      return;
    }
    this.opening = (async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.fileHandle = await open(this.filePath, 'a');
    })();
    await this.opening;
    this.opening = null;
  }

  private async drainBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;
    const lines = this.buffer.splice(0, this.buffer.length);
    try {
      await this.ensureOpen();
      const payload = lines.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await appendFile(this.filePath, payload, 'utf8');
    } catch {
      // If the file write fails, re-queue events so they're not silently dropped
      this.buffer.unshift(...lines);
    }
  }
}
