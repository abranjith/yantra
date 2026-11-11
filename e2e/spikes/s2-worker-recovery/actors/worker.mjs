// Spike S2 — toy detached worker. Usage: node worker.mjs --launch <launch.json>
// Receives everything through the launch file, never through argv (TASK-012 privacy rule).
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EventLog, allocateAddress, startRunServer, CHANNEL_VERSION } from '../lib/channel.mjs';
import { atomicReplace, exclusivePublish, now, removeIfExists } from '../lib/util.mjs';

const started = now();
const launchIndex = process.argv.indexOf('--launch');
if (launchIndex < 0 || process.argv.length !== launchIndex + 2) process.exit(1);
const launch = JSON.parse(readFileSync(process.argv[launchIndex + 1], 'utf8'));
const runDir = launch.runDir;
const leasePath = join(runDir, 'lease.json');

const { currentProcessIdentity, identifyProcess } = await import('@yantra/core');
const importMs = now() - started;

const identityStarted = now();
const owner = await currentProcessIdentity();
const identityMs = now() - identityStarted;

const socket = allocateAddress(launch.yantraHome);
const token = randomBytes(32).toString('base64url');
const log = new EventLog(join(runDir, 'run-events.jsonl'));
const lease = {
  schema_version: 1,
  run_id: launch.runId,
  owner: { pid: owner.pid, start_token: owner.startToken },
  origin: 'worker',
  owned_browsers: [],
  socket,
  run_token: token,
  channel_version: CHANNEL_VERSION,
  log_seq_at_claim: log.lastSeq(),
  claimed_at: new Date().toISOString(),
  heartbeat_at: new Date().toISOString(),
};

try {
  exclusivePublish(leasePath, lease);
} catch (error) {
  writeFileSync(
    join(runDir, `claim-failed-${process.pid}.json`),
    JSON.stringify({ code: error.code }),
  );
  process.exit(3);
}
const claimMs = now() - started;
writeFileSync(
  join(runDir, 'manifest.json'),
  JSON.stringify({ runId: launch.runId, status: 'running', startedAt: lease.claimed_at }),
);

// Toy D12 pending item: the worker is the sole decision authority.
const pending = { id: 'c1', state: 'pending', decision: null, decided_at: null };
const { stats, closeGracefully } = await startRunServer({
  socket,
  token,
  log,
  helloDeadlineMs: launch.helloDeadlineMs ?? 5_000,
  handlers: {
    answer(message) {
      if (message.id !== pending.id)
        return { type: 'answer_result', id: message.id, result: 'stale' };
      if (pending.state !== 'pending') {
        return {
          type: 'answer_result',
          id: pending.id,
          result: 'already_decided',
          decision: pending.decision,
          decided_at: pending.decided_at,
        };
      }
      pending.state = 'decided';
      pending.decision = message.decision;
      pending.decided_at = new Date().toISOString();
      log.append({ type: 'intervention_decided', id: pending.id, decision: pending.decision });
      log.flush(); // Persist and flush before replying (D12).
      return { type: 'answer_result', id: pending.id, result: 'accepted' };
    },
  },
});

if (launch.chrome) {
  const chromeStarted = now();
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    executablePath: launch.chrome.executablePath,
    pipe: true,
    headless: true,
    userDataDir: launch.chrome.userDataDir,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
  });
  const pid = browser.process()?.pid;
  const identity = (await identifyProcess(pid)) ?? { pid, startToken: 'unknown' };
  lease.owned_browsers.push({
    pid: identity.pid,
    start_token: identity.startToken,
    recorded_at: new Date().toISOString(),
  });
  atomicReplace(leasePath, lease);
  const chromeMs = now() - chromeStarted;
  writeFileSync(join(runDir, 'chrome.json'), JSON.stringify({ ...identity, chromeMs }));
}

writeFileSync(
  join(runDir, 'worker-ready.json'),
  JSON.stringify({
    pid: process.pid,
    importMs,
    identityMs,
    claimMs,
    socketKind: socket.kind,
    // Did the spawner's environment reach the worker? (D13: workers inherit the host's env.)
    inheritedEnv: process.env.S2_ENV_PROBE === 'inherited',
  }),
);

let emitted = 0;
let finishing = false;
const finish = async (outcome) => {
  if (finishing) return;
  finishing = true;
  clearInterval(timer);
  clearInterval(heartbeat);
  log.append({ type: 'run_outcome', outcome });
  log.flush();
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify({ runId: launch.runId, status: 'completed', taskOutcome: outcome }),
  );
  // Without this drain the queued terminal frame dies with the process (spike finding).
  if (launch.drainOnExit !== false) await closeGracefully(1_000);
  // Ordering invariant: terminal event and manifest are flushed before the lease goes.
  removeIfExists(leasePath);
  log.close();
  writeFileSync(
    join(runDir, 'done.json'),
    JSON.stringify({ pid: process.pid, lastSeq: log.lastSeq(), outcome, stats }),
  );
  process.exit(0);
};

const timer = setInterval(() => {
  emitted += 1;
  log.append({ type: 'progress', n: emitted });
  if (launch.approval && emitted === 5)
    log.append({ type: 'intervention_requested', id: pending.id });
  const approvalDone = !launch.approval || pending.state === 'decided';
  if (emitted >= launch.events && approvalDone) void finish('fulfilled');
  else if (now() - started > (launch.maxLifetimeMs ?? 120_000)) void finish('failed');
}, launch.intervalMs ?? 10);

const heartbeat = setInterval(() => {
  lease.heartbeat_at = new Date().toISOString();
  try {
    atomicReplace(leasePath, lease);
  } catch {
    // Heartbeat failures never crash the run.
  }
}, 5_000);
