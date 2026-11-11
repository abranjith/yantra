// An owner from a previous channel version (FEAT-064 acceptance): it holds a
// lease and answers every hello with hello_incompatible {min: 0, max: 0},
// counts any frame it receives afterwards, then exits 0 on its own schedule.
//
// Usage: node channel-v0-server.mjs '<json config>'  { runDir, runId, lifetimeMs }
// Prints {"ready":true} and, at exit, {"framesAfterHello":<n>}.

import { createServer } from 'node:net';

import {
  FrameDecoder,
  allocateSocketAddress,
  buildLease,
  encodeJsonFrame,
  publishLease,
  removeOwnershipFiles,
} from '@yantra/core';

const config = JSON.parse(process.argv[2] ?? '{}');
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const address = await allocateSocketAddress();
let framesAfterHello = 0;
const server = createServer((socket) => {
  const decoder = new FrameDecoder();
  let greeted = false;
  socket.on('error', () => undefined);
  socket.on('data', (chunk) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.kind !== 'json') continue;
      if (!greeted) {
        greeted = true;
        socket.write(
          encodeJsonFrame({
            type: 'hello_incompatible',
            supported: { min: 0, max: 0 },
            yantra_version: '0.0.0-v0',
          }),
        );
      } else {
        framesAfterHello += 1;
      }
    }
  });
});
await new Promise((resolve) => server.listen(address.address, resolve));
const lease = await buildLease({
  runId: config.runId,
  origin: 'terminal',
  executionClass: 'run',
  command: ['v0'],
  socket: address,
  logSeqAtClaim: 0,
});
await publishLease(config.runDir, lease);
print({ ready: true });

setTimeout(async () => {
  await removeOwnershipFiles(config.runDir);
  print({ framesAfterHello });
  server.close();
  process.exit(0);
}, config.lifetimeMs ?? 3_000);
