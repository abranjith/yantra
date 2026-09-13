/**
 * Real cross-process owner of a managed claim.
 *
 * Cross-process exclusion cannot be demonstrated with mocked async functions:
 * the guarantee is about two operating-system processes racing for the same
 * files, so this fixture takes a real claim in a real child process and holds
 * it until the parent says otherwise or its deadline expires.
 *
 * Run it as: node --import tsx coordination-owner.mjs --mode <use|mutation> ...
 *
 * Protocol on stdout, one JSON object per line:
 *   {"event":"held", ...}     the claim was acquired and is being held
 *   {"event":"refused", ...}  the claim was refused, with the error reason
 *   {"event":"released"}      the claim was released cleanly
 * A single line on stdin releases the claim and exits.
 */

import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', '..', '..', 'src', 'browser');

const { LocalManagedCoordinator } = await import(
  pathToFileURL(resolve(srcRoot, 'managed-coordination.ts')).href
);
const { LocalManagedStateReader } = await import(
  pathToFileURL(resolve(srcRoot, 'managed-state.ts')).href
);

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const mode = arg('mode', 'use');
const coordinationRoot = arg('coordination');
const operationPath = arg('operation');
const readyPath = arg('ready');
const managedRoot = arg('root');
const deadlineMs = Number.parseInt(arg('deadline', '15000'), 10);

function say(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const coordinator = new LocalManagedCoordinator({
  managedState: new LocalManagedStateReader({
    root: () => managedRoot,
    readyPath: () => readyPath,
  }),
  coordinationRoot: () => coordinationRoot,
  operationPath: () => operationPath,
});

const deadline = setTimeout(() => {
  say({ event: 'deadline' });
  process.exit(3);
}, deadlineMs);
deadline.unref?.();

let release = null;

try {
  if (mode === 'use') {
    const ready = await new LocalManagedStateReader({
      root: () => managedRoot,
      readyPath: () => readyPath,
    }).readReady();
    if (ready.status !== 'ready') {
      say({ event: 'refused', reason: `ready is ${ready.status}` });
      process.exit(4);
    }
    const reservation = await coordinator.reserveUse(ready.record);
    // A reservation with no attached child stays busy on purpose; the fixture
    // proves the never-spawned outcome explicitly when it is told to release.
    release = () => reservation.markNeverSpawned();
    say({ event: 'held', mode, id: reservation.id, pid: process.pid });
  } else {
    const lease = await coordinator.claimMutation(
      arg('operation-id', `op-${process.pid}`),
      arg('candidate', 'installation-candidate'),
    );
    release = () => lease.release();
    say({ event: 'held', mode, operationId: lease.operationId, pid: process.pid });
  }
} catch (error) {
  say({
    event: 'refused',
    reason: error?.context?.reason ?? 'unknown',
    message: String(error?.message ?? error),
  });
  process.exit(4);
}

process.stdin.resume();
process.stdin.once('data', () => {
  void (async () => {
    try {
      await release?.();
      say({ event: 'released' });
      process.exit(0);
    } catch (error) {
      say({ event: 'release-failed', message: String(error?.message ?? error) });
      process.exit(5);
    }
  })();
});
