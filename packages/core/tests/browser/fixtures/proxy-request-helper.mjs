import https from 'node:https';
import process from 'node:process';

process.send?.({
  kind: 'ready',
  protocolVersion: 1,
  nodeVersion: process.versions.node,
  envProxyRequested: process.env.NODE_USE_ENV_PROXY === '1',
});
process.send?.({ kind: 'phase', phase: 'resolving-stable', interruptible: true });

const request = https.get('https://example.invalid/managed-browser-metadata', () => undefined);
request.once('error', () => {
  process.send?.(
    {
      kind: 'error',
      code: 'metadata-unavailable',
      detail: 'Stable metadata could not be reached through the configured proxy.',
    },
    () => process.disconnect?.(),
  );
});
