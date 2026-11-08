// @no-llm
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunEventDelivery } from '@yantra/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { ResourceBusyError } from '../../src/locks/resource-lock.js';
import { RunEventLog } from '../../src/run-events/log.js';
import {
  abandonOwnedStream,
  emitArtifactSaved,
  exitCodeForThrown,
  runOutcomeEvent,
  runRelativePath,
} from '../../src/run-events/run-facts.js';
import { RunEventStream } from '../../src/run-events/stream.js';

import {
  AT,
  ManualScheduler,
  cleanupRunDirs,
  makeRunDir,
  readSeqs,
  runOutcome,
  taskStarted,
} from './support.js';

afterEach(cleanupRunDirs);

function openStream(runDir: string): RunEventStream {
  const stream = new RunEventStream();
  stream.open({ runDir, runId: 'run-1', sync: () => undefined, scheduler: new ManualScheduler() });
  return stream;
}

describe('@no-llm runRelativePath', () => {
  it('returns forward-slash paths inside the run directory', () => {
    const runDir = join('base', 'run');

    expect(runRelativePath(runDir, join(runDir, 'screenshots', 'a.png'))).toBe('screenshots/a.png');
    expect(runRelativePath(runDir, join(runDir, 'brief.json'))).toBe('brief.json');
  });

  it('refuses the directory itself and anything outside it', () => {
    const runDir = join('base', 'run');

    expect(runRelativePath(runDir, runDir)).toBeNull();
    expect(runRelativePath(runDir, join('base', 'other', 'x.json'))).toBeNull();
    expect(runRelativePath(runDir, join('base', 'run-2', 'x.json'))).toBeNull();
  });
});

describe('@no-llm emitArtifactSaved', () => {
  it('records the run-relative path, kind, media type and size', async () => {
    const runDir = await makeRunDir();
    writeFileSync(join(runDir, 'brief.md'), '# Brief\n');
    const stream = openStream(runDir);
    const seen: RunEventDelivery[] = [];
    stream.subscribe((d) => seen.push(d));

    expect(emitArtifactSaved(stream, runDir, join(runDir, 'brief.md'), 'brief', AT)).toBe(true);
    stream.close();

    expect(seen[0]?.event).toEqual({
      kind: 'artifact_saved',
      path: 'brief.md',
      artifact_kind: 'brief',
      media_type: 'text/markdown',
      bytes: 8,
      at: AT,
    });
  });

  it('records an unknown size as null and an unknown extension as octet-stream', async () => {
    const runDir = await makeRunDir();
    const stream = openStream(runDir);
    const seen: RunEventDelivery[] = [];
    stream.subscribe((d) => seen.push(d));

    emitArtifactSaved(stream, runDir, join(runDir, 'vanished.bin'), 'other', AT);
    stream.close();

    expect(seen[0]?.event).toMatchObject({ bytes: null, media_type: 'application/octet-stream' });
  });

  it('never records a file outside the run directory', async () => {
    const runDir = await makeRunDir();
    const stream = openStream(runDir);
    const seen: RunEventDelivery[] = [];
    stream.subscribe((d) => seen.push(d));

    expect(emitArtifactSaved(stream, runDir, join(runDir, '..', 'escape.json'), 'other')).toBe(
      false,
    );
    stream.close();
    expect(seen).toEqual([]);
  });
});

describe('@no-llm run outcome helpers', () => {
  it('builds a schema-shaped run_outcome', () => {
    expect(
      runOutcomeEvent({
        runId: 'r',
        taskOutcome: 'partial',
        terminationReason: 'wall-clock-soft',
        stopDetail: null,
        exitCode: 2,
        failureClass: null,
        at: AT,
      }),
    ).toEqual({
      kind: 'run_outcome',
      run_id: 'r',
      task_outcome: 'partial',
      termination_reason: 'wall-clock-soft',
      stop_detail: null,
      exit_code: 2,
      failure_class: null,
      at: AT,
    });
  });

  it('maps a busy resource to exit 3 and anything else to exit 2', () => {
    expect(exitCodeForThrown(new ResourceBusyError({ kind: 'config' }, null))).toBe(3);
    expect(exitCodeForThrown(new Error('x'))).toBe(2);
    expect(exitCodeForThrown('not an error')).toBe(2);
  });

  it('records a failed outcome and closes an owned stream after a throw', async () => {
    const runDir = await makeRunDir();
    const stream = openStream(runDir);
    stream.emit(taskStarted());

    abandonOwnedStream(stream, true, 'run-1', new Error('boom'));

    expect(stream.closed).toBe(true);
    expect(await readSeqs(join(runDir, 'run-events.jsonl'))).toEqual([1, 2]);
  });

  it('does not add a second outcome to an owned stream', async () => {
    const runDir = await makeRunDir();
    const stream = openStream(runDir);
    stream.emit(runOutcome());

    abandonOwnedStream(stream, true, 'run-1', new Error('late'));

    expect(await readSeqs(join(runDir, 'run-events.jsonl'))).toEqual([1]);
  });

  it('leaves a stream it does not own untouched', async () => {
    const runDir = await makeRunDir();
    const stream = openStream(runDir);

    abandonOwnedStream(stream, false, 'run-1', new Error('boom'));

    expect(stream.closed).toBe(false);
    expect(stream.outcomeRecorded).toBe(false);
    stream.close();
  });

  it('swallows only the duplicate refusal of a reopened log that already ended', async () => {
    const runDir = await makeRunDir();
    const first = RunEventLog.open({ runDir, runId: 'run-1', sync: () => undefined });
    first.append(runOutcome());
    first.close();
    const reopened = openStream(runDir);

    expect(() => abandonOwnedStream(reopened, true, 'run-1', new Error('x'))).not.toThrow();
    expect(reopened.closed).toBe(true);
  });
});

describe('@no-llm resume segments', () => {
  const resumed = {
    kind: 'task_resumed',
    task_id: 't',
    at: AT,
    original_run_id: 'run-1',
    resume_step_id: 's2',
  } as const;

  it('lets a task_resumed segment record its own outcome in the same log', async () => {
    const runDir = await makeRunDir();
    const first = RunEventLog.open({ runDir, runId: 'run-1', sync: () => undefined });
    first.append(runOutcome(2));
    first.close();

    const second = RunEventLog.open({ runDir, runId: 'run-1', sync: () => undefined });
    expect(() => second.append(runOutcome())).toThrow(
      expect.objectContaining({ code: 'RUN_OUTCOME_DUPLICATE' }),
    );
    second.append(resumed);
    expect(second.append(runOutcome())).toBe(3);
    expect(() => second.append(runOutcome())).toThrow(
      expect.objectContaining({ code: 'RUN_OUTCOME_DUPLICATE' }),
    );
    second.close();
  });

  it('tracks outcomeRecorded per segment on the stream', async () => {
    const runDir = await makeRunDir();
    const stream = openStream(runDir);

    expect(stream.outcomeRecorded).toBe(false);
    stream.emit(runOutcome());
    expect(stream.outcomeRecorded).toBe(true);
    stream.emit(resumed);
    expect(stream.outcomeRecorded).toBe(false);
    stream.close();
  });
});
