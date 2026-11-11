/**
 * The run relay (FEAT-065 TASK-016): live run events from a worker's run
 * socket to every app window following that run.
 *
 * - The first `run.subscribe {run_id, from_seq}` attaches one FEAT-064
 *   `RunChannelClient` to the run (token from its lease); the last
 *   unsubscribe detaches it.
 * - Every window has its own `from_seq`. It receives `run.event {run_id, seq,
 *   event}` strictly in order: each window is caught up from
 *   `run-events.jsonl` (written before any event is published, FEAT-063) and
 *   then fed live events, and an event at or below what it already has is
 *   dropped. So no window sees a gap or a duplicate.
 * - An owner speaking an incompatible channel version gets
 *   `run.channel {state: 'live_unavailable', worker_version}`; the worker is
 *   never aborted (D17). A run without a live owner is served from the file.
 * - A worker silent for 30 s gets `run.channel {state: 'not_responding'}`,
 *   logged once; `recovered` follows when it speaks again.
 */

import { join } from 'node:path';

import {
  RunChannelClient,
  readCommittedEvents,
  readLease,
  type ChannelConnectResult,
  type ChannelEventDelivery,
  type RunChannelClientSnapshot,
} from '@yantra/core';
import {
  EmptyParams,
  RunSubscribeParams,
  RunSubscribeResult,
  RunUnsubscribeParams,
} from '@yantra/protocol';

import { SILENT_HOST_LOGGER, type HostLogger } from './host.js';
import type { RpcConnection, RpcMethodRegistry } from './rpc-server.js';

/** The slice of `RunChannelClient` the relay uses (tests supply a fake). */
export interface RelayClient {
  connect(lease: Parameters<RunChannelClient['connect']>[0]): Promise<ChannelConnectResult>;
  subscribe(fromSeq: number): void;
  onEvent(listener: (delivery: ChannelEventDelivery) => void): () => void;
  getSnapshot(): RunChannelClientSnapshot;
  subscribeSnapshot(listener: () => void): () => void;
  /** Sends one message to the owner (attendance, FEAT-065 TASK-018). */
  send(message: { readonly type: string } & Record<string, unknown>): void;
  close(): void;
}

export interface RunRelayDeps {
  readonly runsRoot: string;
  readonly logger?: HostLogger;
  readonly createClient?: (runDir: string) => RelayClient;
  readonly readEvents?: typeof readCommittedEvents;
  readonly readLease?: typeof readLease;
  /** Called when a live client attaches (attendance sends the current count). */
  readonly onAttach?: (runId: string) => void;
  /** Called with every live event of an attached run (intervention forwarding). */
  readonly onLiveEvent?: (runId: string, seq: number, event: unknown) => void;
}

/** How a followed run is served. */
export type RelayChannel = 'live' | 'replay_only' | 'live_unavailable';

/** One window following one run. */
interface Follower {
  readonly connection: RpcConnection;
  nextSeq: number;
  /** Serializes catch-up and live delivery for this window. */
  chain: Promise<void>;
}

interface Attachment {
  readonly runId: string;
  readonly runDir: string;
  readonly followers: Map<number, Follower>;
  client: RelayClient | null;
  channel: RelayChannel;
  notResponding: boolean;
  dispose: (() => void)[];
}

/** See the module comment. */
export class RunRelay {
  private readonly runs = new Map<string, Attachment>();
  private readonly logger: HostLogger;

  public constructor(private readonly deps: RunRelayDeps) {
    this.logger = deps.logger ?? SILENT_HOST_LOGGER;
  }

  /** Runs with at least one follower. */
  public attachedRuns(): string[] {
    return [...this.runs.keys()];
  }

  /** Registers `run.subscribe` and `run.unsubscribe`. */
  public register(methods: RpcMethodRegistry): void {
    methods
      .register('run.subscribe', {
        params: RunSubscribeParams,
        result: RunSubscribeResult,
        handler: async ({ run_id: runId, from_seq: fromSeq }, { connection }) => ({
          channel: await this.follow(connection, runId, fromSeq),
        }),
      })
      .register('run.unsubscribe', {
        params: RunUnsubscribeParams,
        result: EmptyParams,
        handler: ({ run_id: runId }, { connection }) => {
          this.unfollow(connection.id, runId);
          return {};
        },
      });
  }

  /** Adds a follower; resolves once its catch-up has been scheduled. */
  public async follow(
    connection: RpcConnection,
    runId: string,
    fromSeq: number,
  ): Promise<RelayChannel> {
    let attachment = this.runs.get(runId);
    const fresh = attachment === undefined;
    if (attachment === undefined) {
      attachment = {
        runId,
        runDir: join(this.deps.runsRoot, runId),
        followers: new Map(),
        client: null,
        channel: 'replay_only',
        notResponding: false,
        dispose: [],
      };
      this.runs.set(runId, attachment);
    }
    const existing = attachment.followers.get(connection.id);
    const follower: Follower = existing ?? {
      connection,
      nextSeq: fromSeq,
      chain: Promise.resolve(),
    };
    follower.nextSeq = Math.min(follower.nextSeq, fromSeq);
    if (existing === undefined) {
      attachment.followers.set(connection.id, follower);
      connection.onClose(() => {
        this.unfollow(connection.id, runId);
      });
    }
    if (fresh) await this.attach(attachment, fromSeq);
    this.catchUp(attachment, follower, Number.POSITIVE_INFINITY);
    return attachment.channel;
  }

  /** Removes a follower; detaches the run with its last follower. */
  public unfollow(connectionId: number, runId: string): void {
    const attachment = this.runs.get(runId);
    if (attachment === undefined) return;
    attachment.followers.delete(connectionId);
    if (attachment.followers.size > 0) return;
    for (const dispose of attachment.dispose) dispose();
    attachment.client?.close();
    this.runs.delete(runId);
    this.logger.info({ run_id: runId }, 'run detached');
  }

  /** Detaches every run (host shutdown). */
  public close(): void {
    for (const attachment of [...this.runs.values()]) {
      for (const id of [...attachment.followers.keys()]) this.unfollow(id, attachment.runId);
    }
  }

  private async attach(attachment: Attachment, fromSeq: number): Promise<void> {
    const lease = await (this.deps.readLease ?? readLease)(attachment.runDir).catch(() => null);
    if (lease?.kind !== 'lease') return;
    const client = (
      this.deps.createClient ??
      ((runDir: string) => new RunChannelClient({ clientKind: 'host', runDir }))
    )(attachment.runDir);
    const result = await client
      .connect(lease.lease)
      .catch(() => ({ state: 'unreachable' }) as const);
    this.logger.info({ run_id: attachment.runId, state: result.state }, 'run attach');
    if (result.state === 'live_unavailable') {
      attachment.channel = 'live_unavailable';
      client.close();
      this.broadcast(attachment, 'run.channel', {
        run_id: attachment.runId,
        state: 'live_unavailable',
        worker_version: result.ownerVersion,
      });
      return;
    }
    if (result.state !== 'attached') {
      client.close();
      return;
    }
    attachment.client = client;
    attachment.channel = 'live';
    attachment.dispose.push(
      client.onEvent((delivery) => {
        this.deps.onLiveEvent?.(attachment.runId, delivery.seq, delivery.event);
        for (const follower of attachment.followers.values()) {
          this.deliver(attachment, follower, delivery.seq, delivery.event);
        }
      }),
      client.subscribeSnapshot(() => {
        this.watchHealth(attachment, client.getSnapshot());
      }),
    );
    client.subscribe(fromSeq);
    this.deps.onAttach?.(attachment.runId);
  }

  /** Sends `message` to every attached live owner; returns how many got it. */
  public sendToWorkers(message: { readonly type: string } & Record<string, unknown>): number {
    let sent = 0;
    for (const attachment of this.runs.values()) {
      if (attachment.client === null) continue;
      attachment.client.send(message);
      sent += 1;
    }
    return sent;
  }

  /** Sends `message` to one run's live owner, if attached. */
  public sendToWorker(
    runId: string,
    message: { readonly type: string } & Record<string, unknown>,
  ): void {
    this.runs.get(runId)?.client?.send(message);
  }

  private watchHealth(attachment: Attachment, snapshot: RunChannelClientSnapshot): void {
    const silent = snapshot.state === 'not_responding';
    if (silent === attachment.notResponding) return;
    attachment.notResponding = silent;
    if (silent) this.logger.warn({ run_id: attachment.runId }, 'worker not responding');
    this.broadcast(attachment, 'run.channel', {
      run_id: attachment.runId,
      state: silent ? 'not_responding' : 'recovered',
    });
  }

  /** Delivers one live event to a follower, catching up from the file first if needed. */
  private deliver(attachment: Attachment, follower: Follower, seq: number, event: unknown): void {
    follower.chain = follower.chain.then(async () => {
      if (seq < follower.nextSeq) return;
      if (seq > follower.nextSeq) await this.replay(attachment, follower, seq - 1);
      if (seq !== follower.nextSeq) return;
      this.send(attachment, follower, seq, event);
    });
  }

  /** Replays the file for a follower up to `upTo` (inclusive), serialized on its chain. */
  private catchUp(attachment: Attachment, follower: Follower, upTo: number): void {
    follower.chain = follower.chain.then(() => this.replay(attachment, follower, upTo));
  }

  private async replay(attachment: Attachment, follower: Follower, upTo: number): Promise<void> {
    try {
      for await (const committed of (this.deps.readEvents ?? readCommittedEvents)(
        attachment.runDir,
        follower.nextSeq,
      )) {
        if (committed.seq > upTo) break;
        if (committed.seq !== follower.nextSeq) continue;
        this.send(attachment, follower, committed.seq, committed.event);
      }
    } catch (error) {
      this.logger.warn(
        { run_id: attachment.runId, reason: error instanceof Error ? error.name : 'unknown' },
        'run replay failed',
      );
    }
  }

  private send(attachment: Attachment, follower: Follower, seq: number, event: unknown): void {
    follower.nextSeq = seq + 1;
    follower.connection.notify('run.event', { run_id: attachment.runId, seq, event });
  }

  private broadcast(attachment: Attachment, method: string, params: Record<string, unknown>): void {
    for (const follower of attachment.followers.values())
      follower.connection.notify(method, params);
  }
}
