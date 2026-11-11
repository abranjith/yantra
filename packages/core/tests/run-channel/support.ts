import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHANNEL_VERSION,
  RUN_LEASE_SCHEMA_VERSION,
  type RunLease,
  type RunSocketAddress,
} from '@yantra/protocol';

import { resetPathCache } from '../../src/config/resolved-paths.js';
import {
  FrameDecoder,
  encodeJsonFrame,
  type DecodedFrame,
} from '../../src/run-channel/frame-codec.js';
import type { RunChannelTimers } from '../../src/run-channel/server.js';
import { generateRunToken } from '../../src/run-ownership/lease-store.js';

const dirs: string[] = [];
const savedHome = process.env.YANTRA_HOME;

/**
 * Points YANTRA_HOME at a short fresh temp directory, so Unix sockets land in
 * an owner-only directory that fits `sun_path`.
 */
export function sandboxHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yc-'));
  dirs.push(dir);
  process.env.YANTRA_HOME = dir;
  resetPathCache();
  return dir;
}

export function cleanupSandbox(): void {
  if (savedHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = savedHome;
  resetPathCache();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function makeRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yantra-chan-'));
  dirs.push(dir);
  return dir;
}

export const TOKEN = generateRunToken();

export const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** A logger that keeps every call, serialized, for leak assertions. */
export function capturingLogger(): { logger: typeof silentLogger; lines: string[] } {
  const lines: string[] = [];
  const record = (level: string) => (fields: unknown, message?: string) => {
    lines.push(`${level} ${JSON.stringify(fields)} ${message ?? ''}`);
  };
  return {
    lines,
    logger: {
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      debug: record('debug'),
    },
  };
}

export function leaseFor(
  runId: string,
  socket: RunSocketAddress,
  overrides: Partial<RunLease> = {},
): RunLease {
  return {
    schema_version: RUN_LEASE_SCHEMA_VERSION,
    run_id: runId,
    owner: { pid: process.pid, start_token: 'test' },
    origin: 'terminal',
    execution_class: 'run',
    command: ['research'],
    socket,
    run_token: TOKEN,
    channel_version: CHANNEL_VERSION,
    yantra_version: '0.0.1',
    log_seq_at_claim: 0,
    claimed_at: '2026-11-09T12:00:00.000Z',
    ...overrides,
  };
}

/** A raw socket that records every byte it receives and when it closed. */
export class RawPeer {
  public readonly received: Buffer[] = [];
  public readonly closed: Promise<void>;
  private readonly decoder = new FrameDecoder();
  public readonly frames: DecodedFrame[] = [];
  private waiters: { count: number; resolve: () => void }[] = [];

  private constructor(public readonly socket: Socket) {
    this.closed = new Promise((resolve) => socket.once('close', () => resolve()));
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      this.received.push(chunk);
      this.frames.push(...this.decoder.push(chunk));
      this.waiters = this.waiters.filter((waiter) => {
        if (this.frames.length >= waiter.count) {
          waiter.resolve();
          return false;
        }
        return true;
      });
    });
  }

  public static open(address: RunSocketAddress): Promise<RawPeer> {
    return new Promise((resolve, reject) => {
      const socket = connect(address.address);
      socket.once('connect', () => resolve(new RawPeer(socket)));
      socket.once('error', reject);
    });
  }

  public get bytes(): number {
    return this.received.reduce((total, chunk) => total + chunk.length, 0);
  }

  public write(bytes: Uint8Array): void {
    this.socket.write(bytes);
  }

  public sendJson(message: unknown): void {
    this.socket.write(encodeJsonFrame(message));
  }

  public hello(overrides: Record<string, unknown> = {}): void {
    this.sendJson({
      type: 'hello',
      token: TOKEN,
      channel_version: 1,
      capabilities: ['events', 'cancel'],
      client_kind: 'test',
      ...overrides,
    });
  }

  /** Resolves once at least `count` frames arrived in total. */
  public waitForFrames(count: number): Promise<void> {
    if (this.frames.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  public messages(): unknown[] {
    return this.frames.flatMap((frame) => (frame.kind === 'json' ? [frame.message] : []));
  }

  public destroy(): void {
    this.socket.destroy();
  }
}

/** Timers driven by {@link advance}; nothing fires on its own. */
export class ManualTimers implements RunChannelTimers {
  private now = 0;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { at: number; callback: () => void; every: number | null }
  >();

  public setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { at: this.now + ms, callback, every: null });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  public setInterval(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { at: this.now + ms, callback, every: ms });
    return id;
  }

  public clearInterval(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Moves time forward, firing everything due, in time order. */
  public advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let next: [number, { at: number; callback: () => void; every: number | null }] | null = null;
      for (const entry of this.pending) {
        if (entry[1].at <= target && (next === null || entry[1].at < next[1].at)) next = entry;
      }
      if (next === null) break;
      const [id, timer] = next;
      this.now = timer.at;
      if (timer.every === null) this.pending.delete(id);
      else timer.at += timer.every;
      timer.callback();
    }
    this.now = target;
  }

  public get elapsed(): number {
    return this.now;
  }
}

/** Waits until `predicate` holds, polling on the real event loop. */
export async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('until: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
