// Spike S2 — toy run log, run socket server and client (plan §6 and §8 "Event log contract").
import { Buffer } from 'node:buffer';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  openSync,
  writeSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FrameDecoder, MAX_HELLO_BYTES, encodeJson } from './frame.mjs';
import { IS_WIN, readCompleteLines, removeIfExists } from './util.mjs';

export const CHANNEL_VERSION = 1;
export const SUPPORTED = { min: 1, max: 1 };

/** Single-writer, persist-before-publish event log over `run-events.jsonl`. */
export class EventLog {
  constructor(path) {
    this.path = path;
    const lines = readCompleteLines(path);
    this.seq = lines.length > 0 ? JSON.parse(lines[lines.length - 1]).seq : 0;
    this.fd = openSync(path, 'a');
    this.listeners = new Set();
  }

  append(event) {
    this.seq += 1;
    const record = { seq: this.seq, at: new Date().toISOString(), ...event };
    // Persist (write completed) before any listener can publish it.
    writeSync(this.fd, `${JSON.stringify(record)}\n`);
    for (const listener of this.listeners) listener(record);
    return record;
  }

  flush() {
    fsyncSync(this.fd);
  }

  close() {
    closeSync(this.fd);
  }

  lastSeq() {
    return this.seq;
  }

  readRange(from, to) {
    return readCompleteLines(this.path)
      .map((line) => JSON.parse(line))
      .filter((event) => event.seq >= from && event.seq <= to);
  }

  onCommitted(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** POSIX socket directory: `<home>/run` when short enough, else `<tmpdir>/yantra-<uid>`. */
export function socketsRoot(yantraHome) {
  const preferred = join(yantraHome, 'run');
  const probe = join(preferred, `${'0'.repeat(24)}.sock`);
  const root =
    Buffer.byteLength(probe) <= 100 ? preferred : join(tmpdir(), `yantra-${process.getuid()}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Verify rather than repair: a directory someone else loosened or replaced is refused.
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error(`socket directory ${root} is not owner-only`);
  }
  return root;
}

export function allocateAddress(yantraHome) {
  if (IS_WIN)
    return { kind: 'pipe', address: `\\\\.\\pipe\\yantra-${randomBytes(16).toString('hex')}` };
  return {
    kind: 'unix',
    address: join(socketsRoot(yantraHome), `${randomBytes(12).toString('hex')}.sock`),
  };
}

export function tokenMatches(expected, presented) {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Starts the toy run socket. Per connection: hello within the deadline (16 KiB limit), token
 * checked with timingSafeEqual, then subscribe with the atomic replay-to-live watermark.
 */
export function startRunServer({ socket, token, log, helloDeadlineMs = 5_000, handlers = {} }) {
  const stats = { connections: 0, rejected: {}, attached: 0, subscribes: 0 };
  const open = new Set();
  const reject = (conn, reason) => {
    stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1;
    conn.destroy();
  };

  const server = createServer((conn) => {
    stats.connections += 1;
    open.add(conn);
    conn.once('close', () => open.delete(conn));
    const decoder = new FrameDecoder(MAX_HELLO_BYTES);
    let authed = false;
    let unsubscribe = null;
    let generation = 0;
    const deadline = setTimeout(() => reject(conn, 'hello_deadline'), helloDeadlineMs);
    deadline.unref();

    const send = (message) => conn.write(encodeJson(message));

    const subscribe = async (fromSeq) => {
      stats.subscribes += 1;
      unsubscribe?.();
      const mine = ++generation;
      const buffered = [];
      let live = false;
      // 1. register the buffering listener; 2. take the watermark — same tick, one event loop.
      unsubscribe = log.onCommitted((event) => {
        if (live) send({ type: 'event', seq: event.seq, event });
        else buffered.push(event);
      });
      const watermark = log.lastSeq();
      // 3. stream file events from_seq..W, paced by socket drain.
      for (const event of log.readRange(fromSeq, watermark)) {
        if (mine !== generation || conn.destroyed) return;
        if (!send({ type: 'event', seq: event.seq, event })) {
          await new Promise((resolve) => conn.once('drain', resolve));
        }
      }
      if (mine !== generation || conn.destroyed) return;
      // 4. flush buffered events above W; 5. go live — synchronously, so nothing slips between.
      for (const event of buffered) {
        if (event.seq > watermark && event.seq >= fromSeq) {
          send({ type: 'event', seq: event.seq, event });
        }
      }
      live = true;
    };

    conn.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind === 'fatal') return reject(conn, authed ? 'fatal_frame' : 'fatal_hello');
        if (frame.kind !== 'json') return reject(conn, 'non_json');
        const message = frame.message;
        if (!authed) {
          if (message?.type !== 'hello') return reject(conn, 'non_hello_first');
          if (!tokenMatches(token, message.token)) return reject(conn, 'bad_token');
          const negotiated = Math.min(Number(message.channel_version) || 0, CHANNEL_VERSION);
          clearTimeout(deadline);
          authed = true;
          decoder.setLimit(null);
          if (negotiated < SUPPORTED.min || negotiated > SUPPORTED.max) {
            send({ type: 'hello_incompatible', supported: SUPPORTED });
            conn.end();
            return;
          }
          stats.attached += 1;
          send({ type: 'hello_ok', channel_version: negotiated, supported: SUPPORTED });
          continue;
        }
        if (message.type === 'subscribe') {
          void subscribe(Number(message.from_seq) || 1);
        } else if (message.type === 'ping') {
          send({ type: 'pong' });
        } else if (handlers[message.type]) {
          send(handlers[message.type](message));
        } else {
          send({ type: 'error', code: 'unsupported', message: message.type });
        }
      }
    });
    conn.on('close', () => {
      clearTimeout(deadline);
      unsubscribe?.();
    });
    conn.on('error', () => {
      // A client vanishing mid-write is ordinary; the owner keeps running.
    });
  });

  return new Promise((resolve, reject2) => {
    if (socket.kind === 'unix') removeIfExists(socket.address);
    server.once('error', reject2);
    server.listen(socket.address, () => {
      if (socket.kind === 'unix') chmodSync(socket.address, 0o600);
      /** Stops accepting, half-closes every client and waits (bounded) for queued bytes to flush. */
      const closeGracefully = async (ms) => {
        server.close();
        const pending = [...open].map(
          (conn) => new Promise((done) => (conn.once('close', done), conn.end())),
        );
        await Promise.race([Promise.all(pending), new Promise((done) => setTimeout(done, ms))]);
        for (const conn of open) conn.destroy();
      };
      resolve({ server, stats, closeGracefully });
    });
  });
}

/** Connects and collects every decoded frame and the raw byte count. */
export function connectRaw(address) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(address);
    const state = { conn, bytes: 0, frames: [], closed: false, closedAt: null };
    const decoder = new FrameDecoder();
    conn.on('data', (chunk) => {
      state.bytes += chunk.length;
      for (const frame of decoder.push(chunk)) {
        state.frames.push(frame);
        state.onFrame?.(frame);
      }
    });
    conn.on('close', () => {
      state.closed = true;
      state.closedAt = Date.now();
    });
    conn.once('connect', () => resolve(state));
    conn.once('error', (error) => {
      if (!state.closed) reject(error);
    });
  });
}
