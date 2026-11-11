/**
 * `RunChannelServer` — the run socket a run's owner serves (FEAT-064, plan §6).
 *
 * Every connection must authenticate in its first frame: a JSON `hello`
 * carrying the lease's `run_token`, within {@link HELLO_DEADLINE_MS} and at
 * most 16 KiB. Anything else — no hello, a wrong token, a non-hello first
 * frame, an oversized or malformed frame — destroys the socket with **zero
 * bytes written**, so an unauthenticated peer learns nothing.
 *
 * After `hello_ok` the connection speaks run-channel JSON messages. Built-in
 * types are `subscribe` and `ping`; other types are served by handlers that
 * the run registers (`cancel`; later features add their own), and a type with
 * no handler gets `error{unsupported}` while the connection stays open.
 *
 * The token and the socket address are never logged.
 */

import { timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';

import {
  CHANNEL_VERSION,
  MAX_HELLO_FRAME_BYTES,
  RunChannelClientMessage,
  SUPPORTED_CHANNEL_VERSIONS,
  type RunChannelServerMessage,
  type RunSocketAddress,
} from '@yantra/protocol';

import type { Logger } from '../browser/types.js';
import {
  HEARTBEAT_INTERVAL_MS,
  HELLO_DEADLINE_MS,
  OUTBOUND_EVENT_QUEUE_BYTES,
} from '../run-ownership/constants.js';
import { yantraVersion } from '../run-ownership/lease-store.js';
import type { RunChannelEndpoint, StartRunChannel } from '../run-ownership/ownership-session.js';

import type { CommittedEvent, RunEventSource } from './event-source.js';
import {
  FrameDecoder,
  RunChannelFrameError,
  encodeJsonFrame,
  encodeScreencastFrame,
} from './frame-codec.js';
import { OutboundQueues } from './outbound-queues.js';
import { allocateSocketAddress, removeStaleSocket } from './socket-address.js';

/** Timer seam; the defaults are unref'd so the socket never holds the process open. */
export interface RunChannelTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realTimers: RunChannelTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** A message a handler receives: a client message of a type it registered. */
export type ChannelRequest = { readonly type: string } & Readonly<Record<string, unknown>>;

/** The authenticated connection, as a handler sees it. */
export interface ChannelConnection {
  readonly clientKind: 'host' | 'cli' | 'test';
  readonly channelVersion: number;
  send(message: RunChannelServerMessage): void;
}

export type ChannelHandler = (request: ChannelRequest, connection: ChannelConnection) => void;

export interface RunChannelServerOptions {
  readonly runId: string;
  /** The lease's `run_token`; compared in constant time. */
  readonly token: string;
  readonly logger?: Logger;
  /** Defaults to a fresh address from {@link allocateSocketAddress}. */
  readonly address?: RunSocketAddress;
  readonly timers?: RunChannelTimers;
  readonly clock?: () => Date;
  readonly helloDeadlineMs?: number;
  /** Advertised capabilities that need no handler; defaults to `events`. */
  readonly builtInCapabilities?: readonly string[];
  /** The run's events; may be attached later with {@link RunChannelServer.attachEvents}. */
  readonly events?: RunEventSource;
  /** Per-connection event-queue bound in encoded bytes. */
  readonly maxEventBytes?: number;
  /** Interval of the per-connection `heartbeat`. */
  readonly heartbeatMs?: number;
}

type ConnectionState = 'hello' | 'open' | 'closed';

/** Types the server answers itself, never through a handler. */
const BUILT_IN_TYPES = new Set(['hello', 'ping', 'subscribe']);

export class RunChannelServer implements RunChannelEndpoint {
  private readonly handlers = new Map<string, ChannelHandler>();
  private readonly capabilities = new Set<string>();
  private readonly connections = new Set<ServerConnection>();
  private readonly logger: Logger;
  private readonly timers: RunChannelTimers;
  private readonly clock: () => Date;
  private readonly expectedToken: Buffer;
  private closing: Promise<void> | null = null;
  private eventSource: RunEventSource | null;

  private constructor(
    private readonly server: Server,
    public readonly address: RunSocketAddress,
    private readonly options: RunChannelServerOptions,
  ) {
    this.logger = options.logger ?? noopLogger;
    this.timers = options.timers ?? realTimers;
    this.clock = options.clock ?? (() => new Date());
    this.expectedToken = Buffer.from(options.token, 'utf8');
    for (const capability of options.builtInCapabilities ?? ['events']) {
      this.capabilities.add(capability);
    }
    this.eventSource = options.events ?? null;
  }

  /**
   * Attaches the run's event log once it is open. A `subscribe` that arrived
   * earlier waits for this, then replays and goes live.
   */
  public attachEvents(source: RunEventSource): void {
    this.eventSource = source;
    for (const connection of this.connections) connection.onEventsAttached();
  }

  /** @internal */
  public get events(): RunEventSource | null {
    return this.eventSource;
  }

  /** Allocates an address (unless given), listens, and resolves once accepting. */
  public static async listen(options: RunChannelServerOptions): Promise<RunChannelServer> {
    const address = options.address ?? (await allocateSocketAddress());
    const server = createServer({ allowHalfOpen: false, pauseOnConnect: false });
    const channel = new RunChannelServer(server, address, options);
    server.on('connection', (socket) => {
      channel.accept(socket);
    });
    try {
      await listenOn(server, address.address);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      // Only a stale Unix socket file inside the sockets root is ever removed.
      if (!(await removeStaleSocket(address))) throw error;
      await listenOn(server, address.address);
    }
    return channel;
  }

  /**
   * Serves `type` with `handler`, advertising `capability` (when given) in
   * `hello_ok` to clients that ask for it.
   */
  public register(type: string, capability: string | null, handler: ChannelHandler): void {
    if (BUILT_IN_TYPES.has(type)) throw new Error(`"${type}" is answered by the server itself.`);
    this.handlers.set(type, handler);
    if (capability !== null) this.capabilities.add(capability);
  }

  /** Adds a capability served by the server itself (the event stream adds `events`). */
  public advertise(capability: string): void {
    this.capabilities.add(capability);
  }

  /** Authenticated connections still open. */
  public get connectionCount(): number {
    let count = 0;
    for (const connection of this.connections) if (connection.state === 'open') count += 1;
    return count;
  }

  /**
   * Offers one screencast frame to every connection (FEAT-069 produces them).
   * Each connection keeps only the newest unsent frame, behind its events.
   */
  public publishFrame(meta: unknown, jpeg: Uint8Array): void {
    let frame: Buffer | null = null;
    for (const connection of this.connections) {
      if (connection.state !== 'open') continue;
      frame ??= encodeScreencastFrame(meta, jpeg);
      connection.offerFrame(frame);
    }
  }

  /** Sends a message to every authenticated connection. */
  public broadcast(message: RunChannelServerMessage): void {
    for (const connection of this.connections) {
      if (connection.state === 'open') connection.send(message);
    }
  }

  /**
   * Stops accepting, ends every connection, waits up to `drainMs` for them to
   * close, then destroys any left (spike S2, RC3). Idempotent.
   */
  public close(drainMs: number): Promise<void> {
    this.closing ??= this.doClose(drainMs);
    return this.closing;
  }

  private async doClose(drainMs: number): Promise<void> {
    const serverClosed = new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
    const open = [...this.connections];
    for (const connection of open) connection.end();
    const allClosed = Promise.all(open.map((connection) => connection.closed));
    let timer: unknown;
    await Promise.race([
      allClosed,
      new Promise<void>((resolve) => {
        timer = this.timers.setTimeout(resolve, drainMs);
      }),
    ]);
    this.timers.clearTimeout(timer);
    for (const connection of this.connections) connection.destroy();
    await serverClosed;
    if (this.address.kind === 'unix') await rm(this.address.address, { force: true });
  }

  private accept(socket: Socket): void {
    if (this.closing !== null) {
      socket.destroy();
      return;
    }
    const connection = new ServerConnection(socket, this);
    this.connections.add(connection);
    void connection.closed.then(() => this.connections.delete(connection));
  }

  /** @internal */
  public get deps(): {
    readonly timers: RunChannelTimers;
    readonly clock: () => Date;
    readonly logger: Logger;
    readonly helloDeadlineMs: number;
    readonly heartbeatMs: number;
    readonly maxEventBytes: number;
  } {
    return {
      timers: this.timers,
      clock: this.clock,
      logger: this.logger,
      helloDeadlineMs: this.options.helloDeadlineMs ?? HELLO_DEADLINE_MS,
      heartbeatMs: this.options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS,
      maxEventBytes: this.options.maxEventBytes ?? OUTBOUND_EVENT_QUEUE_BYTES,
    };
  }

  /** @internal Constant-time token check; a length mismatch is simply wrong. */
  public tokenMatches(token: string): boolean {
    const offered = Buffer.from(token, 'utf8');
    if (offered.length !== this.expectedToken.length) return false;
    return timingSafeEqual(offered, this.expectedToken);
  }

  /** @internal */
  public negotiate(
    clientVersion: number,
    clientCapabilities: readonly string[],
  ): { readonly version: number; readonly capabilities: string[] } | null {
    const version = Math.min(clientVersion, CHANNEL_VERSION);
    if (version < SUPPORTED_CHANNEL_VERSIONS.min) return null;
    return {
      version,
      capabilities: clientCapabilities.filter((capability) => this.capabilities.has(capability)),
    };
  }

  /** @internal */
  public dispatch(request: ChannelRequest, connection: ServerConnection): void {
    const handler = this.handlers.get(request.type);
    if (handler === undefined) {
      connection.send({ type: 'error', code: 'unsupported', message: request.type });
      return;
    }
    try {
      handler(request, connection);
    } catch (error) {
      this.logger.warn(
        {
          event: 'run_channel_handler_failed',
          type: request.type,
          error_class: error instanceof Error ? error.name : typeof error,
        },
        'run_channel_handler_failed',
      );
      connection.send({ type: 'error', code: 'bad_request', message: request.type });
    }
  }

  /** @internal */
  public get runId(): string {
    return this.options.runId;
  }
}

function listenOn(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

/** One accepted socket, from unauthenticated to closed. */
class ServerConnection implements ChannelConnection {
  public state: ConnectionState = 'hello';
  public clientKind: 'host' | 'cli' | 'test' = 'test';
  public channelVersion = 0;
  public readonly closed: Promise<void>;
  private readonly decoder = new FrameDecoder({ limit: MAX_HELLO_FRAME_BYTES });
  private helloTimer: unknown;
  private heartbeatTimer: unknown = null;
  private attachedAt = 0;
  private readonly queues: OutboundQueues;
  /** Bumped by every `subscribe`, so a superseded replay stops. */
  private generation = 0;
  private pendingFromSeq: number | null = null;
  private disposeListener: (() => void) | null = null;

  public constructor(
    private readonly socket: Socket,
    private readonly server: RunChannelServer,
  ) {
    const { timers, helloDeadlineMs } = server.deps;
    this.closed = new Promise((resolve) => {
      socket.once('close', () => {
        this.onClose();
        resolve();
      });
    });
    this.queues = new OutboundQueues(socket, {
      maxEventBytes: server.deps.maxEventBytes,
      onOverflow: () => {
        this.onOverflow();
      },
    });
    socket.on('error', () => undefined); // 'close' follows; nothing to report
    socket.on('data', (chunk: Buffer) => {
      this.onData(chunk);
    });
    this.helloTimer = timers.setTimeout(() => {
      if (this.state === 'hello') this.destroy();
    }, helloDeadlineMs);
  }

  /** Queues a control message; never waits. */
  public send(message: RunChannelServerMessage): void {
    if (this.state !== 'open') return;
    this.queues.enqueue(encodeJsonFrame(message));
  }

  /** @internal Offers a screencast frame to this connection's one-frame slot. */
  public offerFrame(frame: Buffer): void {
    if (this.state === 'open') this.queues.offerFrame(frame);
  }

  /** @internal Screencast frames replaced before they were written. */
  public get droppedFrames(): number {
    return this.queues.droppedFrames;
  }

  /** Hands one replayed event to the socket, waiting while the socket is full. */
  private sendPaced(event: CommittedEvent): Promise<void> {
    if (this.state !== 'open') return Promise.resolve();
    return this.queues.enqueueReplay(eventFrame(event));
  }

  /** Queues one live event; never waits. */
  private sendEvent(event: CommittedEvent): void {
    if (this.state !== 'open') return;
    this.queues.enqueue(eventFrame(event));
  }

  /**
   * The client stopped reading: send one best-effort `error{overflow}` and
   * drop this connection only. Its client reconnects and replays from the file.
   */
  private onOverflow(): void {
    this.server.deps.logger.warn(
      { event: 'channel_overflow', client_kind: this.clientKind },
      'channel_overflow',
    );
    this.socket.write(
      encodeJsonFrame({ type: 'error', code: 'overflow', message: 'event queue overflow' }),
    );
    this.destroy();
  }

  /**
   * Replay-to-live (plan §8), all on the owner's event loop: register a
   * buffering listener, read the watermark W, stream the file from `fromSeq`
   * to W paced by drain, flush buffered events above W in order, then forward
   * live. A later `subscribe` supersedes this one.
   */
  private subscribe(fromSeq: number): void {
    this.generation += 1;
    this.disposeListener?.();
    this.disposeListener = null;
    const source = this.server.events;
    if (source === null) {
      this.pendingFromSeq = fromSeq;
      return;
    }
    this.pendingFromSeq = null;
    const generation = this.generation;
    // Live events that arrive during the replay wait here, encoded. They count
    // against the same bound as the event queue: a client that stalls during
    // its replay must overflow like any other, not grow this buffer forever.
    const buffered: { readonly seq: number; readonly frame: Buffer }[] = [];
    let bufferedBytes = 0;
    let live = false;
    this.disposeListener = source.subscribe((event) => {
      if (generation !== this.generation || event.seq < fromSeq) return;
      if (live) {
        this.sendEvent(event);
        return;
      }
      const frame = eventFrame(event);
      bufferedBytes += frame.length;
      if (bufferedBytes > this.server.deps.maxEventBytes) {
        this.generation += 1;
        this.disposeListener?.();
        this.disposeListener = null;
        buffered.length = 0;
        this.onOverflow();
        return;
      }
      buffered.push({ seq: event.seq, frame });
    });
    const watermark = source.lastSeq;
    const current = (): boolean => generation === this.generation && this.state === 'open';
    void (async () => {
      if (fromSeq <= watermark) {
        for await (const event of source.read(fromSeq)) {
          if (!current()) return;
          if (event.seq > watermark) break;
          await this.sendPaced(event);
        }
      }
      if (!current()) return;
      for (const entry of buffered) {
        if (entry.seq > watermark && this.state === 'open') this.queues.enqueue(entry.frame);
      }
      buffered.length = 0;
      live = true;
    })().catch(() => {
      this.destroy();
    });
  }

  /** @internal */
  public onEventsAttached(): void {
    if (this.pendingFromSeq !== null && this.state === 'open') this.subscribe(this.pendingFromSeq);
  }

  /** Graceful close: unauthenticated connections are destroyed instead. */
  public end(): void {
    if (this.state !== 'open') {
      this.destroy();
      return;
    }
    this.queues.drainThen(() => {
      this.socket.end();
    });
  }

  public destroy(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    for (const frame of this.decoder.push(chunk)) {
      if (this.state === 'closed') return;
      if (frame.kind !== 'json') {
        // Fatal framing, or a screencast frame no client may send.
        this.destroy();
        return;
      }
      if (this.state === 'hello') this.onHello(frame.message);
      else this.onMessage(frame.message);
    }
  }

  private onHello(raw: unknown): void {
    const parsed = RunChannelClientMessage.safeParse(raw);
    if (!parsed.success || parsed.data.type !== 'hello') {
      this.destroy();
      return;
    }
    const hello = parsed.data as Extract<RunChannelClientMessage, { type: 'hello' }>;
    if (!this.server.tokenMatches(hello.token)) {
      this.destroy();
      return;
    }
    const { timers, clock, logger } = this.server.deps;
    timers.clearTimeout(this.helloTimer);
    this.decoder.setLimit(null);
    this.clientKind = hello.client_kind;
    const negotiated = this.server.negotiate(hello.channel_version, hello.capabilities);
    if (negotiated === null) {
      this.socket.end(
        encodeJsonFrame({
          type: 'hello_incompatible',
          supported: { ...SUPPORTED_CHANNEL_VERSIONS },
          yantra_version: yantraVersion(),
        }),
      );
      this.state = 'closed';
      return;
    }
    this.channelVersion = negotiated.version;
    this.state = 'open';
    this.attachedAt = clock().getTime();
    this.heartbeatTimer = timers.setInterval(() => {
      this.send({ type: 'heartbeat', at: clock().toISOString() });
    }, this.server.deps.heartbeatMs);
    this.send({
      type: 'hello_ok',
      channel_version: negotiated.version,
      supported: { ...SUPPORTED_CHANNEL_VERSIONS },
      capabilities: negotiated.capabilities,
      run_id: this.server.runId,
    });
    logger.info(
      {
        event: 'channel_attached',
        client_kind: this.clientKind,
        channel_version: this.channelVersion,
      },
      'channel_attached',
    );
  }

  private onMessage(raw: unknown): void {
    const parsed = RunChannelClientMessage.safeParse(raw);
    if (!parsed.success) {
      const type =
        typeof raw === 'object' &&
        raw !== null &&
        typeof (raw as { type?: unknown }).type === 'string'
          ? (raw as { type: string }).type
          : 'message';
      this.send({ type: 'error', code: 'bad_request', message: type });
      return;
    }
    const message = parsed.data as ChannelRequest;
    switch (message.type) {
      case 'hello':
        this.send({ type: 'error', code: 'bad_request', message: 'hello' });
        return;
      case 'subscribe':
        this.subscribe((message as unknown as { from_seq: number }).from_seq);
        return;
      case 'ping':
        this.send({ type: 'heartbeat', at: this.server.deps.clock().toISOString() });
        return;
      default:
        this.server.dispatch(message, this);
    }
  }

  private onClose(): void {
    const wasOpen = this.state === 'open';
    this.state = 'closed';
    this.generation += 1;
    this.disposeListener?.();
    this.disposeListener = null;
    const { timers, clock, logger } = this.server.deps;
    timers.clearTimeout(this.helloTimer);
    timers.clearInterval(this.heartbeatTimer);
    if (wasOpen) {
      logger.info(
        {
          event: 'channel_detached',
          client_kind: this.clientKind,
          channel_version: this.channelVersion,
          duration_ms: Math.max(0, clock().getTime() - this.attachedAt),
        },
        'channel_detached',
      );
    }
  }
}

/** One event as a frame; an event too large for a frame becomes `event_oversize`. */
function eventFrame(event: CommittedEvent): Buffer {
  try {
    return encodeJsonFrame({ type: 'event', seq: event.seq, event: event.event });
  } catch (error) {
    if (error instanceof RunChannelFrameError && error.code === 'FRAME_TOO_LARGE') {
      return encodeJsonFrame({ type: 'event_oversize', seq: event.seq });
    }
    throw error;
  }
}

/** The run socket every ownership session starts by default. */
export const startRunChannelServer: StartRunChannel = async ({ runId, token, logger }) =>
  RunChannelServer.listen({ runId, token, logger });
