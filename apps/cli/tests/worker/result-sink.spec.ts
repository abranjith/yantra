// @no-llm
/**
 * The worker result is written atomically, exactly once (FEAT-064 TASK-012).
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandResultMessage } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkerResultSink } from '../../src/worker/result-sink.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yantra-worker-result-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const first: CommandResultMessage = { type: 'result', exit_code: 0, envelope: null, text: null };
const second: CommandResultMessage = {
  type: 'error',
  exit_code: 2,
  code: 'LATE',
  message: 'rejected after resolving',
  remediation: null,
};

describe('@no-llm WorkerResultSink', () => {
  it('writes once; a later write (a handler rejecting after resolving) is refused', async () => {
    const path = join(dir, 'x.result.json');
    const sink = new WorkerResultSink(path, { invocationId: 'id-1' });
    expect(await sink.write(first)).toBe(true);
    expect(await sink.write(second)).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      schema_version: 1,
      invocation_id: 'id-1',
      outcome: first,
    });
    expect(sink.done).toBe(true);
  });

  it('never overwrites a result another writer already published', async () => {
    const path = join(dir, 'x.result.json');
    writeFileSync(path, 'existing');
    expect(await new WorkerResultSink(path, { invocationId: 'id-1' }).write(first)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('existing');
  });

  it('leaves no temp file behind', async () => {
    await new WorkerResultSink(join(dir, 'x.result.json'), { invocationId: 'id' }).write(first);
    expect(readdirSync(dir)).toEqual(['x.result.json']);
  });

  it.skipIf(process.platform === 'win32')('writes the result owner-only (0600)', async () => {
    const path = join(dir, 'x.result.json');
    await new WorkerResultSink(path, { invocationId: 'id' }).write(first);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
