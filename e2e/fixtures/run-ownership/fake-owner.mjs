// A scripted run owner for the FEAT-064 acceptance suite: it owns a run
// directory through the real RunOwnershipSession, writes run-events.jsonl
// through the real RunEventStream, and serves the real run socket.
//
// Usage: node fake-owner.mjs '<json config>'
//   { runDir, runId, events, intervalMs, burst, textBytes,
//     cancel: 'honor' | 'ignore' | 'none', forever }
//
// Prints one JSON line per notable moment: {"ready":true}, every logger
// call ({"log":"channel_overflow",...}), {"done":true}.

import { RunEventStream, RunOwnershipSession } from '@yantra/core';

const config = JSON.parse(process.argv[2] ?? '{}');
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const log = (fields, message) => print({ log: message ?? fields?.event ?? 'log', fields });
const logger = { info: log, warn: log, error: log, debug: () => undefined };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const at = () => new Date().toISOString();

const session = await RunOwnershipSession.open({
  runDir: config.runDir,
  runId: config.runId,
  origin: 'worker',
  executionClass: 'run',
  command: ['fake'],
  logger,
});
const stream = new RunEventStream({ logger });
stream.open({ runDir: config.runDir, runId: config.runId });
session.attachEvents(stream);

let cancelled = false;
if (config.cancel === 'honor' || config.cancel === 'ignore') {
  session.onCancel(() => {
    cancelled = true;
    print({ cancelled: true });
  });
}
print({ ready: true, pid: process.pid });

const text = 'e'.repeat(config.textBytes ?? 32);
let emitted = 0;
for (;;) {
  if (cancelled && config.cancel === 'honor') break;
  if (!config.forever && emitted >= (config.events ?? 100)) break;
  for (let index = 0; index < (config.burst ?? 1); index += 1) {
    stream.emit({ kind: 'assistant_text', text: `${emitted + 1}:${text}`, at: at() });
    emitted += 1;
  }
  await sleep(config.intervalMs ?? 5);
}

const aborted = cancelled && config.cancel === 'honor';
stream.emit({
  kind: 'run_outcome',
  run_id: config.runId,
  task_outcome: aborted ? 'aborted' : 'fulfilled',
  termination_reason: aborted ? 'user_abort' : 'model_finished',
  stop_detail: null,
  exit_code: aborted ? 130 : 0,
  failure_class: aborted ? 'user_aborted' : null,
  at: at(),
});
stream.close();
await session.finish();
print({ done: true, emitted });
process.exit(0);
