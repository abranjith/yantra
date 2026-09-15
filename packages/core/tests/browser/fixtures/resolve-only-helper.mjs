/**
 * Scripted resolve-mode helper.
 *
 * `operationId` selects the scenario, matching `fake-install-helper.mjs`'s
 * convention. The `log` scenario records what it was asked for into
 * `$YANTRA_HOME/requests.jsonl`, so a test can assert on the *request the
 * helper received* rather than on the options object the parent constructed.
 * It logs under `YANTRA_HOME` because the client's environment allowlist is
 * deliberately fixed, and a bespoke variable would not survive it.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const request = JSON.parse(process.argv[2] ?? '{}');
const mode = request.operationId ?? 'happy';
const send = (message, callback) => process.send?.(message, callback);
const finish = (message) => send(message, () => process.disconnect?.());

if (mode === 'log' && process.env.YANTRA_HOME) {
  appendFileSync(join(process.env.YANTRA_HOME, 'requests.jsonl'), `${JSON.stringify(request)}\n`);
}

send({
  kind: 'ready',
  protocolVersion: 2,
  nodeVersion: process.versions.node,
  envProxyRequested: process.env.NODE_USE_ENV_PROXY === '1',
});
send({ kind: 'phase', phase: 'resolving-stable', interruptible: true });

if (mode === 'silent') {
  // Answers nothing, so the metadata deadline is the only thing that ends it.
  globalThis.setInterval(() => undefined, 1_000);
} else if (mode === 'unavailable-artifact') {
  finish({ kind: 'availability', buildId: '153.0.8010.36', artifactAvailable: false });
} else if (mode.startsWith('error-')) {
  finish({ kind: 'error', code: mode.slice('error-'.length), detail: 'scripted metadata failure' });
} else if (mode === 'wrong-shape') {
  // An install result answering a resolve request: a protocol failure, never an
  // availability answer.
  finish({ kind: 'result', buildId: '153.0.8010.36', executableRelative: 'chrome/chrome' });
} else if (mode === 'credentialed-proxy-error') {
  finish({
    kind: 'error',
    code: 'proxy-failure',
    detail: 'connect ECONNREFUSED via http://proxy.internal:3128',
  });
} else {
  finish({
    kind: 'availability',
    buildId: mode.startsWith('build-') ? mode.slice('build-'.length) : '153.0.8010.36',
    artifactAvailable: true,
  });
}
