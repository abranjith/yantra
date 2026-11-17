/**
 * The FEAT-069 evidence rig: the real live-view pipeline end to end.
 *
 * worker:  real Chrome task page (the agent controller) → real focus guard,
 *          screencast and `LiveViewHub` → real run socket (`RunChannelServer`
 *          + `serveLiveViewOnRunSocket`)
 * host:    real `RunChannelClient` (token-authenticated, `frames/1`) → real
 *          `LiveViewRelay`, logging to a `host.log` file
 * windows: recording `RpcConnection`s that decode every binary frame and ack
 *          it, the way the app does
 *
 * Only the app's WebSocket and DOM are replaced; the app's draw-time floor
 * is covered by its own suite. Vitest-free (memory).
 */

import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LiveViewRelay, type RpcConnection } from '@yantra/cli';
import {
  AgentBrowserController,
  LiveViewHub,
  LocalBrowserProvider,
  LocalProfileStore,
  RunChannelClient,
  RunChannelServer,
  ScreencastSource,
  generateRunToken,
  serveLiveViewOnRunSocket,
  type LiveViewHubOptions,
  type Logger,
  type ScreencastSourceOptions,
  type TaskPageSource,
} from '@yantra/core';
import {
  CHANNEL_VERSION,
  FRAMES_CAPABILITY,
  RUN_LEASE_SCHEMA_VERSION,
  decodeFramePayload,
  type FramesState,
  type RunLease,
} from '@yantra/protocol';

export const RIG_RUN_ID = '20261115T120000Z-do-11ve11ew';

const silent: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** What one window saw, in arrival order. */
export type WindowEntry =
  | { readonly kind: 'cleared'; readonly generation: number; readonly at: number }
  | { readonly kind: 'state'; readonly state: FramesState; readonly at: number }
  | {
      readonly kind: 'frame';
      readonly generation: number;
      readonly frameSeq: number;
      readonly capturedAt: number;
      readonly bytes: number;
      readonly at: number;
    };

export interface RecordingWindow {
  readonly id: number;
  readonly entries: WindowEntry[];
  readonly connection: RpcConnection;
  /** Stops acking (a stalled window). */
  stall(): void;
  /** Closes the window (its WebSocket dropped). */
  close(): void;
  frames(): Extract<WindowEntry, { kind: 'frame' }>[];
  lastState(): FramesState | null;
}

export interface Rig {
  readonly controller: AgentBrowserController;
  readonly hub: LiveViewHub;
  readonly relay: LiveViewRelay;
  readonly hostLogPath: string;
  /** Opens a window watching the run (frames.subscribe). */
  openWindow(): RecordingWindow;
  /** Swaps the task page source (a replay run's page instead of the controller's). */
  attach(source: TaskPageSource): void;
  close(): Promise<void>;
}

export interface RigOptions {
  /** Holds every captured frame this long before the hub sees it (an injected worker delay). */
  readonly delayFramesMs?: number;
}

/** A capture whose frames reach the hub `delayMs` after Chrome produced them. */
function delayedCapture(delayMs: number): NonNullable<LiveViewHubOptions['startCapture']> {
  return (options: ScreencastSourceOptions) =>
    ScreencastSource.start({
      ...options,
      onFrame: (frame) => {
        setTimeout(() => {
          options.onFrame(frame);
        }, delayMs);
      },
    });
}

export async function openRig(options: RigOptions = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'yantra-live-view-rig-'));
  const hostLogPath = join(dir, 'host.log');
  const hostLog = (level: string) => (fields: Record<string, unknown>, message: string) => {
    appendFileSync(hostLogPath, `${JSON.stringify({ level, ...fields, msg: message })}\n`);
  };

  const controller = new AgentBrowserController({
    runId: RIG_RUN_ID,
    browserProvider: new LocalBrowserProvider({
      profileStore: new LocalProfileStore(),
      logger: silent,
    }),
    logger: silent,
  });
  const hub = new LiveViewHub({
    logger: silent,
    ...(options.delayFramesMs === undefined
      ? {}
      : { startCapture: delayedCapture(options.delayFramesMs) }),
  });
  hub.attach(controller.taskPageSource());

  const token = generateRunToken();
  const server = await RunChannelServer.listen({ runId: RIG_RUN_ID, token, logger: silent });
  serveLiveViewOnRunSocket(
    {
      registerChannelHandler: (type, capability, handler) =>
        server.register(type, capability, handler),
    },
    hub,
  );
  const lease: RunLease = {
    schema_version: RUN_LEASE_SCHEMA_VERSION,
    run_id: RIG_RUN_ID,
    owner: { pid: process.pid, start_token: 'rig' },
    origin: 'terminal',
    execution_class: 'run',
    command: ['do'],
    socket: server.address,
    run_token: token,
    channel_version: CHANNEL_VERSION,
    yantra_version: '0.0.0',
    log_seq_at_claim: 0,
    claimed_at: new Date().toISOString(),
  };
  const client = new RunChannelClient({
    clientKind: 'host',
    runDir: dir,
    capabilities: ['events', FRAMES_CAPABILITY],
  });
  const attached = await client.connect(lease);
  if (attached.state !== 'attached') throw new Error(`host could not attach: ${attached.state}`);
  const relay = new LiveViewRelay({
    runs: {
      owner: () => ({ channel: 'live', live: { client, capabilities: attached.capabilities } }),
    },
    logger: { info: hostLog('info'), warn: hostLog('warn'), error: hostLog('error') },
  });

  let nextWindow = 1;
  const windows: RecordingWindow[] = [];
  const openWindow = (): RecordingWindow => {
    const id = nextWindow++;
    const entries: WindowEntry[] = [];
    const closers: (() => void)[] = [];
    let acking = true;
    const connection: RpcConnection = {
      id,
      windowId: `rig-${id}`,
      notify: (method, params) => {
        if (method === 'frames.cleared') {
          entries.push({
            kind: 'cleared',
            generation: params.generation as number,
            at: Date.now(),
          });
        } else if (method === 'frames.state') {
          const { run_id: _run, ...state } = params;
          entries.push({ kind: 'state', state: state as unknown as FramesState, at: Date.now() });
        }
      },
      onClose: (listener) => closers.push(listener),
      sendBinary: (bytes) => {
        const decoded = decodeFramePayload(bytes);
        if (decoded instanceof Error) throw decoded;
        entries.push({
          kind: 'frame',
          generation: decoded.meta.generation,
          frameSeq: decoded.meta.frame_seq,
          capturedAt: Date.parse(decoded.meta.captured_at),
          bytes: bytes.length,
          at: Date.now(),
        });
        // The app acks after it draws; a short delay keeps acks off the send path.
        if (acking) {
          setTimeout(() => {
            if (acking) relay.windowAck(id, RIG_RUN_ID, decoded.meta.frame_seq);
          }, 5);
        }
        return true;
      },
      bufferedAmount: () => 0,
    };
    const window: RecordingWindow = {
      id,
      entries,
      connection,
      stall: () => {
        acking = false;
      },
      close: () => {
        acking = false;
        for (const closer of closers) closer();
      },
      frames: () => entries.filter((entry) => entry.kind === 'frame'),
      lastState: () => {
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index]!;
          if (entry.kind === 'state') return entry.state;
        }
        return null;
      },
    };
    windows.push(window);
    const state = relay.subscribe(connection, RIG_RUN_ID);
    entries.push({ kind: 'state', state, at: Date.now() });
    return window;
  };

  return {
    controller,
    hub,
    relay,
    hostLogPath,
    openWindow,
    attach: (source) => hub.attach(source),
    close: async () => {
      for (const window of windows) window.close();
      relay.close();
      client.close();
      await hub.close();
      await controller.teardown();
      await server.close(0);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/** Polls until `predicate` holds, or throws with `describe()` after `timeoutMs`. */
export async function until(
  predicate: () => boolean,
  timeoutMs = 10_000,
  describe: () => string = () => '',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met in time ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
