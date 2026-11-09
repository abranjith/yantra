// Spike S2 — toy "host": reads the lease, attaches, replays from --from, follows live.
// Usage: node host.mjs --run-dir <dir> --from <seq> --record <file> [--answer] [--answers-out <file>]
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHANNEL_VERSION, connectRaw } from '../lib/channel.mjs';
import { encodeJson } from '../lib/frame.mjs';
import { now, readJson, waitFor } from '../lib/util.mjs';

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const runDir = arg('--run-dir');
const fromSeq = Number(arg('--from') ?? 1);
const record = arg('--record');
const answersOut = arg('--answers-out');
const answer = process.argv.includes('--answer');
const started = now();

const lease = await waitFor(() => readJson(join(runDir, 'lease.json')), 30_000);
if (!lease) process.exit(5);

const state = await connectRaw(lease.socket.address);
let last = fromSeq - 1;
let firstEventMs = null;
const anomalies = { duplicates: 0, gaps: 0 };
const answers = [];
let answered = false;

state.onFrame = (frame) => {
  if (frame.kind !== 'json') return;
  const message = frame.message;
  if (message.type === 'hello_ok') {
    state.conn.write(encodeJson({ type: 'subscribe', from_seq: fromSeq }));
  } else if (message.type === 'event') {
    firstEventMs ??= now() - started;
    if (message.seq <= last) {
      anomalies.duplicates += 1;
      return;
    }
    if (message.seq !== last + 1) anomalies.gaps += 1;
    last = message.seq;
    appendFileSync(record, `${message.seq}\n`);
    const event = message.event;
    if (answer && !answered) {
      answered = true;
      // Answer twice on this connection: the second must be already_decided.
      state.conn.write(encodeJson({ type: 'answer', id: 'c1', decision: 'approve' }));
      state.conn.write(encodeJson({ type: 'answer', id: 'c1', decision: 'deny' }));
    }
    if (event.type === 'run_outcome') finish(0);
  } else if (message.type === 'answer_result') {
    answers.push(message);
  }
};
state.conn.write(
  encodeJson({
    type: 'hello',
    token: lease.run_token,
    channel_version: CHANNEL_VERSION,
    capabilities: ['events'],
  }),
);
state.conn.on('close', () => finish(6));

function finish(code) {
  if (answersOut) {
    writeFileSync(answersOut, JSON.stringify({ answers, anomalies, firstEventMs, last }));
  }
  process.exit(code);
}
