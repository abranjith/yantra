// @no-llm
/**
 * The evidence-based outcome of an interrupted run (FEAT-064 TASK-009, D7).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunEventType } from '@yantra/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { RunEventLog } from '../../src/run-events/log.js';
import { resultEvidence } from '../../src/run-ownership/result-evidence.js';
import { AT, assistantText, taskStarted } from '../run-events/support.js';

import { cleanupDirs, makeTempDir } from './support.js';

afterEach(cleanupDirs);

function saved(kind: string): RunEventType {
  return {
    kind: 'artifact_saved',
    path: 'x.json',
    artifact_kind: kind,
    media_type: 'application/json',
    bytes: 2,
    at: AT,
  } as RunEventType;
}

function runWith(events: readonly RunEventType[]): string {
  const runDir = makeTempDir();
  const log = RunEventLog.open({ runDir, runId: 'r', sync: () => undefined });
  for (const event of events) log.append(event);
  log.close();
  return runDir;
}

describe('@no-llm resultEvidence', () => {
  it('is failed with no result', async () => {
    expect(await resultEvidence(runWith([taskStarted(), assistantText('x')]), 0)).toBe('failed');
  });

  it.each(['brief', 'templated_report', 'output', 'result'])(
    'is partial after a %s artifact in this epoch',
    async (kind) => {
      expect(await resultEvidence(runWith([taskStarted(), saved(kind)]), 0)).toBe('partial');
    },
  );

  it.each(['report', 'screenshot', 'other'])('ignores a %s artifact', async (kind) => {
    expect(await resultEvidence(runWith([taskStarted(), saved(kind)]), 0)).toBe('failed');
  });

  it('ignores a result saved in an earlier epoch', async () => {
    expect(await resultEvidence(runWith([saved('brief'), taskStarted()]), 1)).toBe('failed');
  });

  it.each(['brief.json', 'outputs.json', 'document.json', 'document.md'])(
    'is partial with a non-empty %s',
    async (name) => {
      const runDir = runWith([]);
      writeFileSync(join(runDir, name), '{}');
      expect(await resultEvidence(runDir, 0)).toBe('partial');
    },
  );

  it('ignores an empty result file and a missing log', async () => {
    const runDir = makeTempDir();
    writeFileSync(join(runDir, 'brief.json'), '');
    expect(await resultEvidence(runDir, 0)).toBe('failed');
  });
});
