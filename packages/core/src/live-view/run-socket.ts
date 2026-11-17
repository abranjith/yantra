/**
 * The live view on the run socket (FEAT-069 TASK-008).
 *
 * Registers `frames.start`, `frames.stop` and `frame.ack` on the run's
 * ownership session, advertising `frames/1` in `hello_ok`. Each authenticated
 * connection that negotiated `frames/1` and sends `frames.start` becomes one
 * hub client:
 *
 * - `frames.cleared` and `frames.state` go on the connection's control/event
 *   queue, which always flushes before frames (plan §6); a `frames.cleared`
 *   first drops the connection's unsent frame, so nothing of an older
 *   generation can follow it;
 * - frames (type `0x02`) go to the connection's one-slot frame queue, newest
 *   wins;
 * - a disconnect stops that client.
 *
 * Unauthenticated connections never reach a handler (the server's rule).
 */

import { FRAMES_CAPABILITY } from '@yantra/protocol';

import type { ChannelConnection, ChannelHandler } from '../run-channel/server.js';

import type { LiveViewClient, LiveViewHub } from './live-view-hub.js';

/** The part of an ownership session the live view needs. */
export interface LiveViewChannelHost {
  registerChannelHandler(type: string, capability: string | null, handler: ChannelHandler): void;
}

function sizeOf(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

/** Serves the hub's frames on the run socket. Call once per run. */
export function serveLiveViewOnRunSocket(host: LiveViewChannelHost, hub: LiveViewHub): void {
  const clients = new WeakMap<ChannelConnection, LiveViewClient>();

  const clientFor = (connection: ChannelConnection): LiveViewClient | null => {
    const existing = clients.get(connection);
    if (existing !== undefined) return existing;
    if (connection.sendFrame === undefined) return null;
    const client = hub.addClient({
      control: (message) => {
        if (message.type === 'frames.cleared') connection.clearFrame?.();
        connection.send(message);
      },
      frame: (meta, jpeg) => {
        // A frame that cannot be framed is never written; the next is offered.
        if (connection.sendFrame?.(meta, jpeg) !== true) {
          client.ack({ generation: meta.generation, frame_seq: meta.frame_seq });
        }
      },
    });
    clients.set(connection, client);
    connection.whenClosed?.(() => {
      client.close();
    });
    return client;
  };

  const negotiated = (connection: ChannelConnection): boolean =>
    connection.capabilities?.includes(FRAMES_CAPABILITY) === true;

  host.registerChannelHandler('frames.start', FRAMES_CAPABILITY, (message, connection) => {
    if (!negotiated(connection)) {
      connection.send({ type: 'error', code: 'unsupported', message: 'frames.start' });
      return;
    }
    clientFor(connection)?.start({
      max_width: sizeOf(message.max_width, 1280, 320, 1920),
      max_height: sizeOf(message.max_height, 800, 240, 1200),
    });
  });
  host.registerChannelHandler('frames.stop', FRAMES_CAPABILITY, (_message, connection) => {
    clients.get(connection)?.stop();
  });
  host.registerChannelHandler('frame.ack', FRAMES_CAPABILITY, (message, connection) => {
    const generation = message.generation;
    const frameSeq = message.frame_seq;
    if (typeof generation !== 'number' || typeof frameSeq !== 'number') return;
    clients.get(connection)?.ack({ generation, frame_seq: frameSeq });
  });
}
