import process from 'node:process';

const request = JSON.parse(process.argv[2] ?? '{}');
const mode = request.operationId;
const send = (message, callback) => process.send?.(message, callback);
const finish = (message) => send(message, () => process.disconnect?.());

send({
  kind: 'ready',
  protocolVersion: 2,
  nodeVersion: process.versions.node,
  envProxyRequested: process.env.NODE_USE_ENV_PROXY === '1',
});

if (mode === 'malformed') {
  finish({ kind: 'not-a-protocol-message' });
} else if (mode === 'exit-zero') {
  process.disconnect?.();
} else if (mode === 'stall') {
  send({ kind: 'resolved', buildId: '153.0.8010.36' });
  send({ kind: 'phase', phase: 'downloading', interruptible: true });
  globalThis.setInterval(() => undefined, 1_000);
} else if (mode === 'block-finalize') {
  process.on('message', (message) => {
    if (message?.kind === 'cancel') finish({ kind: 'cancel-ack' });
  });
  send({ kind: 'resolved', buildId: '153.0.8010.36' });
  send({ kind: 'phase', phase: 'finalizing', interruptible: false }, () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  });
} else if (mode.startsWith('cancel-')) {
  const phase = mode.slice('cancel-'.length);
  process.on('message', (message) => {
    if (message?.kind === 'cancel') finish({ kind: 'cancel-ack' });
  });
  if (phase !== 'resolving-stable') send({ kind: 'resolved', buildId: '153.0.8010.36' });
  send({ kind: 'phase', phase, interruptible: true });
} else {
  send({ kind: 'resolved', buildId: '153.0.8010.36' });
  send({ kind: 'phase', phase: 'downloading', interruptible: true });
  send({ kind: 'progress', downloadedBytes: 50, totalBytes: 100 });
  finish({ kind: 'result', buildId: '153.0.8010.36', executableRelative: 'chrome/linux/chrome' });
}
