/**
 * The recorded `research --no-llm` run (FEAT-067) and a relay that replays it
 * the way the host does, for route tests.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RunEventRecord } from '@yantra/protocol';

import type { FakeRpc } from './fake-rpc.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'research-no-llm.run-events.jsonl');

/** The recorded `research --no-llm` run, each line validated as a protocol record. */
export function recordedResearch(): { runId: string; records: RunEventRecord[] } {
  const records = readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => RunEventRecord.parse(JSON.parse(line)));
  return { runId: records[0]!.run_id, records };
}

/** A relay that replays `records` from the requested seq, as the host does. */
export function relayRecords(rpc: FakeRpc, records: readonly RunEventRecord[]): FakeRpc {
  return rpc
    .answer('run.subscribe', (params) => {
      for (const record of records) {
        if (record.seq >= (params.from_seq as number)) {
          rpc.notify('run.event', { run_id: record.run_id, seq: record.seq, event: record.event });
        }
      }
      return { channel: 'replay_only' };
    })
    .answer('run.unsubscribe', {});
}
