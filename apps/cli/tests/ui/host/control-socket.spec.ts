// @no-llm
/**
 * The app host's control socket (FEAT-065 TASK-005): token first, no reply to
 * anyone else, then launch codes and status.
 */

import { connect, type Socket } from 'node:net';

import { allocateSocketAddress, encodeJsonFrame, FrameDecoder } from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ControlClient,
  ControlSocketError,
  ControlSocketServer,
  type ControlHostStatus,
} from '../../../src/ui/host/control-socket.js';

const TOKEN = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg';
const STATUS: ControlHostStatus = {
  pid: 4242,
  port: 51_234,
  build_id: 'build-c',
  yantra_version: '0.0.1',
  started_at: '2026-11-11T10:00:00.000Z',
};

let server: ControlSocketServer;
let issued: number;

beforeEach(async () => {
  issued = 0;
  server = await ControlSocketServer.listen({
    token: TOKEN,
    helloTimeoutMs: 200,
    issueLaunchCode: () => {
      issued += 1;
      return { code: `code-${issued}`, expiresAt: Date.parse('2026-11-11T10:01:00.000Z') };
    },
    status: () => STATUS,
  });
});

afterEach(async () => {
  await server.close();
});

/** A raw client: sends frames, collects decoded replies, records close. */
function rawClient(): Promise<{
  socket: Socket;
  replies: unknown[];
  closed: Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const socket = connect(server.address);
    const replies: unknown[] = [];
    const decoder = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind === 'json') replies.push(frame.message);
      }
    });
    socket.on('error', () => undefined);
    const closed = new Promise<void>((done) => socket.once('close', () => done()));
    socket.once('connect', () => resolve({ socket, replies, closed }));
    socket.once('error', reject);
  });
}

describe('authentication', () => {
  it('answers hello_ok to the right token, then issues launch codes', async () => {
    // Act
    const client = await ControlClient.connect(server.address, TOKEN);
    const first = await client.issueLaunchCode();
    const second = await client.issueLaunchCode();
    client.close();

    // Assert
    expect(first).toEqual({ code: 'code-1', expiresAt: '2026-11-11T10:01:00.000Z' });
    expect(second.code).toBe('code-2');
  });

  it('reports host status', async () => {
    const client = await ControlClient.connect(server.address, TOKEN);
    expect(await client.status()).toEqual(STATUS);
    client.close();
  });

  it('closes a wrong-token client without any reply', async () => {
    const { socket, replies, closed } = await rawClient();
    socket.write(encodeJsonFrame({ type: 'hello', control_token: 'wrong', channel_version: 1 }));
    await closed;
    expect(replies).toEqual([]);
    expect(issued).toBe(0);
  });

  it('closes a client whose first message is not hello, without a reply', async () => {
    const { socket, replies, closed } = await rawClient();
    socket.write(encodeJsonFrame({ type: 'launch_code.issue', id: 1 }));
    await closed;
    expect(replies).toEqual([]);
    expect(issued).toBe(0);
  });

  it('closes a silent client after the hello timeout', async () => {
    const { replies, closed } = await rawClient();
    await closed;
    expect(replies).toEqual([]);
  });

  it('closes a client that sends a hello frame over 16 KiB', async () => {
    const { socket, replies, closed } = await rawClient();
    socket.write(
      encodeJsonFrame({ type: 'hello', control_token: 'x'.repeat(20_000), channel_version: 1 }),
    );
    await closed;
    expect(replies).toEqual([]);
  });

  it('closes a client that sends garbage bytes', async () => {
    const { socket, replies, closed } = await rawClient();
    socket.write(Buffer.from([0x09, 0, 0, 0, 1, 0]));
    await closed;
    expect(replies).toEqual([]);
  });

  it('makes ControlClient.connect fail clearly on a wrong token', async () => {
    await expect(ControlClient.connect(server.address, 'wrong', 1_000)).rejects.toBeInstanceOf(
      ControlSocketError,
    );
  });

  it('fails clearly when no host listens', async () => {
    const nowhere = await allocateSocketAddress();
    await expect(ControlClient.connect(nowhere.address, TOKEN, 500)).rejects.toBeInstanceOf(
      ControlSocketError,
    );
  });
});

describe('after authentication', () => {
  it('answers an unknown message with an error, keeping the connection', async () => {
    const { socket, replies } = await rawClient();
    socket.write(encodeJsonFrame({ type: 'hello', control_token: TOKEN, channel_version: 1 }));
    socket.write(encodeJsonFrame({ type: 'shutdown', id: 3 }));
    socket.write(encodeJsonFrame({ type: 'host.status', id: 4 }));
    await expect.poll(() => replies.length).toBe(3);
    expect(replies[0]).toEqual({ type: 'hello_ok', channel_version: 1 });
    expect(replies[1]).toMatchObject({ type: 'error', code: 'bad_request' });
    expect(replies[2]).toMatchObject({ type: 'host.status', id: 4, pid: 4242 });
    socket.destroy();
  });

  it('refuses a second hello', async () => {
    const { socket, replies } = await rawClient();
    socket.write(encodeJsonFrame({ type: 'hello', control_token: TOKEN, channel_version: 1 }));
    socket.write(encodeJsonFrame({ type: 'hello', control_token: TOKEN, channel_version: 1 }));
    await expect.poll(() => replies.length).toBe(2);
    expect(replies[1]).toMatchObject({ type: 'error' });
    socket.destroy();
  });
});
