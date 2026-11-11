// A client that authenticates, subscribes from the start, and then never reads
// again (FEAT-064 acceptance). It blocks its own event loop, so nothing drains
// the socket and the operating system's buffer fills on every platform.
//
// Usage: node slow-client.mjs <runDir>
// Prints {"stalled":true} once subscribed, then blocks until killed.

import { connect } from 'node:net';

import { encodeJsonFrame, readLease } from '@yantra/core';

const runDir = process.argv[2];
const read = await readLease(runDir);
if (read.kind !== 'lease') {
  process.stdout.write(`${JSON.stringify({ error: read.kind })}\n`);
  process.exit(1);
}
const socket = connect(read.lease.socket.address);
await new Promise((resolve) => socket.once('connect', resolve));
const send = (message) =>
  new Promise((resolve) => {
    socket.write(encodeJsonFrame(message), resolve);
  });
await send({
  type: 'hello',
  token: read.lease.run_token,
  channel_version: 1,
  capabilities: ['events'],
  client_kind: 'test',
});
await send({ type: 'subscribe', from_seq: 1 });
// Flush the line, then block the event loop for good: no read ever runs again.
process.stdout.write(`${JSON.stringify({ stalled: true })}\n`, () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
