/**
 * The app host's control socket (FEAT-065 TASK-005).
 *
 * `yantra ui` reaches a running host here to get a launch code. It is a local
 * socket (Unix socket in the 0700 run-socket directory, or an unguessable
 * Windows named pipe) speaking FEAT-064's framing, JSON frames only. The
 * first frame must be `hello` carrying `host.lock`'s `control_token`, at most
 * 16 KiB and within 5 s; anything else closes the connection without a reply.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';

import {
  allocateSocketAddress,
  encodeJsonFrame,
  FrameDecoder,
  removeStaleSocket,
} from '@yantra/core';
import {
  APP_CHANNEL_VERSION,
  ControlClientMessage,
  ControlServerMessage,
  MAX_HELLO_FRAME_BYTES,
  type RunSocketAddress,
} from '@yantra/protocol';

import { SILENT_HOST_LOGGER, type HostLogger } from './host.js';

/** How long a control client may take to send `hello`. */
export const CONTROL_HELLO_TIMEOUT_MS = 5_000;

/** What `host.status` reports. */
export interface ControlHostStatus {
  readonly pid: number;
  readonly port: number;
  readonly build_id: string;
  readonly yantra_version: string;
  readonly started_at: string;
}

export interface ControlSocketDeps {
  /** The token every client must present first. */
  readonly token: string;
  readonly issueLaunchCode: () => { readonly code: string; readonly expiresAt: number };
  readonly status: () => ControlHostStatus;
  readonly logger?: HostLogger;
  readonly helloTimeoutMs?: number;
  /** Address seam (tests); defaults to a fresh run-socket address. */
  readonly address?: RunSocketAddress;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** The host side; see the module comment. */
export class ControlSocketServer {
  private readonly sockets = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    public readonly socketAddress: RunSocketAddress,
  ) {}

  /** The address recorded in `host.lock` (`control_socket`). */
  public get address(): string {
    return this.socketAddress.address;
  }

  /** Allocates an address and starts accepting. */
  public static async listen(deps: ControlSocketDeps): Promise<ControlSocketServer> {
    const address = deps.address ?? (await allocateSocketAddress());
    const logger = deps.logger ?? SILENT_HOST_LOGGER;
    const tokenDigest = digest(deps.token);
    let instance: ControlSocketServer | null = null;
    const server = createServer((socket) => {
      instance?.sockets.add(socket);
      socket.once('close', () => instance?.sockets.delete(socket));
      serveConnection(socket, tokenDigest, deps, logger);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address.address, () => {
        server.off('error', reject);
        resolve();
      });
    });
    instance = new ControlSocketServer(server, address);
    return instance;
  }

  /** Stops accepting, closes every connection and removes a Unix socket file. */
  public async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
    await removeStaleSocket(this.socketAddress).catch(() => false);
  }
}

function serveConnection(
  socket: Socket,
  tokenDigest: Buffer,
  deps: ControlSocketDeps,
  logger: HostLogger,
): void {
  const decoder = new FrameDecoder({ limit: MAX_HELLO_FRAME_BYTES });
  let authenticated = false;
  const timer = setTimeout(() => {
    if (!authenticated) socket.destroy();
  }, deps.helloTimeoutMs ?? CONTROL_HELLO_TIMEOUT_MS);
  timer.unref();
  socket.on('error', () => undefined);
  socket.once('close', () => {
    clearTimeout(timer);
  });
  const send = (message: ControlServerMessage): void => {
    if (!socket.destroyed) socket.write(encodeJsonFrame(message));
  };
  socket.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.kind !== 'json') {
        socket.destroy();
        return;
      }
      const parsed = ControlClientMessage.safeParse(frame.message);
      if (!authenticated) {
        const ok =
          parsed.success &&
          parsed.data.type === 'hello' &&
          timingSafeEqual(digest(parsed.data.control_token), tokenDigest);
        if (!ok) {
          logger.warn({ reason: 'control_auth' }, 'control client refused');
          socket.destroy();
          return;
        }
        authenticated = true;
        clearTimeout(timer);
        decoder.setLimit(null);
        send({ type: 'hello_ok', channel_version: APP_CHANNEL_VERSION });
        continue;
      }
      if (!parsed.success || parsed.data.type === 'hello') {
        send({ type: 'error', id: null, code: 'bad_request', message: 'Unknown control message.' });
        continue;
      }
      const request = parsed.data;
      if (request.type === 'launch_code.issue') {
        const issued = deps.issueLaunchCode();
        send({
          type: 'launch_code',
          id: request.id,
          code: issued.code,
          expires_at: new Date(issued.expiresAt).toISOString(),
        });
        logger.info({}, 'launch code issued');
      } else {
        send({ type: 'host.status', id: request.id, ...deps.status() });
      }
    }
  });
}

/** The control client could not get an answer from the host. */
export class ControlSocketError extends Error {
  public override readonly name = 'ControlSocketError';
}

/** The client side, used by `yantra ui`. */
export class ControlClient {
  private nextId = 1;
  private readonly waiters = new Map<number, (message: ControlServerMessage) => void>();
  private failure: Error | null = null;

  private constructor(private readonly socket: Socket) {}

  /**
   * Connects and authenticates.
   *
   * @throws ControlSocketError when the host refuses, closes or does not answer in time.
   */
  public static async connect(
    address: string,
    token: string,
    timeoutMs = CONTROL_HELLO_TIMEOUT_MS,
  ): Promise<ControlClient> {
    const socket = connect(address);
    const client = new ControlClient(socket);
    const decoder = new FrameDecoder();
    let hello: ((message: ControlServerMessage) => void) | null = null;
    const helloReply = new Promise<ControlServerMessage>((resolve) => {
      hello = resolve;
    });
    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind !== 'json') {
          socket.destroy();
          return;
        }
        const parsed = ControlServerMessage.safeParse(frame.message);
        if (!parsed.success) continue;
        const message = parsed.data;
        if (message.type === 'hello_ok') {
          hello?.(message);
          continue;
        }
        if (message.id !== null) client.waiters.get(message.id)?.(message);
      }
    });
    const closed = new Promise<never>((_resolve, reject) => {
      socket.once('error', (error) => {
        client.failure = new ControlSocketError(
          `The app host control socket failed: ${error.message}.`,
        );
        reject(client.failure);
      });
      socket.once('close', () => {
        client.failure ??= new ControlSocketError('The app host closed the control socket.');
        reject(client.failure);
        for (const waiter of client.waiters.values())
          waiter({ type: 'error', id: null, code: 'closed', message: 'closed' });
      });
    });
    closed.catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    }).catch((error: Error) => {
      throw new ControlSocketError(`The app host control socket is unreachable: ${error.message}.`);
    });
    socket.write(
      encodeJsonFrame({
        type: 'hello',
        control_token: token,
        channel_version: APP_CHANNEL_VERSION,
      }),
    );
    await withTimeout(Promise.race([helloReply, closed]), timeoutMs, () => {
      socket.destroy();
      return new ControlSocketError('The app host did not answer the control socket in time.');
    });
    return client;
  }

  /** Asks the host for a fresh single-use launch code. */
  public async issueLaunchCode(
    timeoutMs = CONTROL_HELLO_TIMEOUT_MS,
  ): Promise<{ code: string; expiresAt: string }> {
    const reply = await this.request({ type: 'launch_code.issue', id: this.nextId++ }, timeoutMs);
    if (reply.type !== 'launch_code')
      throw new ControlSocketError('The app host did not issue a launch code.');
    return { code: reply.code, expiresAt: reply.expires_at };
  }

  /** Asks the host for its status. */
  public async status(timeoutMs = CONTROL_HELLO_TIMEOUT_MS): Promise<ControlHostStatus> {
    const reply = await this.request({ type: 'host.status', id: this.nextId++ }, timeoutMs);
    if (reply.type !== 'host.status')
      throw new ControlSocketError('The app host did not report its status.');
    const { type: _type, id: _id, ...status } = reply;
    return status;
  }

  public close(): void {
    this.socket.destroy();
  }

  private request(
    message: ControlClientMessage & { id: number },
    timeoutMs: number,
  ): Promise<ControlServerMessage> {
    if (this.failure !== null) return Promise.reject(this.failure);
    const reply = new Promise<ControlServerMessage>((resolve) => {
      this.waiters.set(message.id, (value) => {
        this.waiters.delete(message.id);
        resolve(value);
      });
    });
    this.socket.write(encodeJsonFrame(message));
    return withTimeout(
      reply,
      timeoutMs,
      () => new ControlSocketError('The app host did not answer in time.'),
    );
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(onTimeout());
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
