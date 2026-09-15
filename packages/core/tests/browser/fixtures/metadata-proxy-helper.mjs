/**
 * Resolve-mode helper that makes a real HTTPS request before answering.
 *
 * The proxy bypass this exists to catch is silent: `@puppeteer/browsers` imports
 * `proxy-agent` optionally and goes direct when it is absent, so asserting that
 * `HTTPS_PROXY` was set in the child's environment proves nothing at all. Only a
 * proxy that records having been contacted is evidence.
 */
import https from 'node:https';
import process from 'node:process';

process.send?.({
  kind: 'ready',
  protocolVersion: 2,
  nodeVersion: process.versions.node,
  envProxyRequested: process.env.NODE_USE_ENV_PROXY === '1',
});
process.send?.({ kind: 'phase', phase: 'resolving-stable', interruptible: true });

const request = https.get('https://example.invalid/last-known-good-versions.json', () => undefined);
request.once('error', () => {
  process.send?.(
    {
      kind: 'error',
      code: 'proxy-failure',
      detail: 'Stable metadata could not be reached through the configured proxy.',
    },
    () => process.disconnect?.(),
  );
});
