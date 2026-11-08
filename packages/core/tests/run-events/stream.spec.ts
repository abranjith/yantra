// @no-llm
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunEventDelivery, TaskEvent } from '@yantra/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonlEventBus } from '../../src/executor/event-bus.js';
import { RUN_EVENTS_FILENAME, RunEventLog } from '../../src/run-events/log.js';
import { MirroringEventBus, openTaskEventBus } from '../../src/run-events/mirroring-event-bus.js';
import { PRE_OPEN_BUFFER_LIMIT, RunEventStream } from '../../src/run-events/stream.js';

import {
  AT,
  ManualScheduler,
  assistantText,
  cleanupRunDirs,
  makeRunDir,
  readAll,
  readSeqs,
  runOutcome,
  taskStarted,
} from './support.js';

afterEach(cleanupRunDirs);

function recordingLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function openStream(stream: RunEventStream, runDir: string): void {
  stream.open({ runDir, runId: 'run-1', sync: () => undefined, scheduler: new ManualScheduler() });
}

function goalEcho(display = 'goal: "x"') {
  return { kind: 'goal_echo', display, received_chars: 1, truncated: false, at: AT } as const;
}

describe('@no-llm RunEventStream persist before publish', () => {
  it('never delivers to a committed subscriber before the line is on disk', async () => {
    const runDir = await makeRunDir();
    const stream = new RunEventStream();
    openStream(stream, runDir);
    const path = join(runDir, RUN_EVENTS_FILENAME);
    const seen: string[] = [];
    stream.subscribe((delivery) => {
      // The listener reads the file synchronously: its own line must be there.
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      const last = JSON.parse(lines.at(-1) ?? '{}') as { seq: number };
      expect(last.seq).toBe(delivery.seq);
      expect(delivery.committed).toBe(true);
      seen.push(delivery.event.kind);
    });

    stream.emit(taskStarted());
    stream.emit(assistantText('a'));
    stream.emit(runOutcome());
    stream.close();

    expect(seen).toEqual(['task_started', 'assistant_text', 'run_outcome']);
  });

  it('delivers the producer’s own event object, in emission order, with gap-free seqs', async () => {
    const runDir = await makeRunDir();
    const stream = new RunEventStream();
    openStream(stream, runDir);
    const deliveries: RunEventDelivery[] = [];
    stream.subscribe((d) => deliveries.push(d));
    const events = [taskStarted(), assistantText('x'), runOutcome()];

    for (const event of events) stream.emit(event);
    stream.close();

    expect(deliveries.map((d) => d.event)).toEqual(events);
    expect(deliveries[1]?.event).toBe(events[1]);
    expect(deliveries.map((d) => d.seq)).toEqual([1, 2, 3]);
  });
});

describe('@no-llm RunEventStream before open', () => {
  it('shows pre-open events only to includeUncommitted subscribers, immediately', () => {
    const stream = new RunEventStream();
    const local: RunEventDelivery[] = [];
    const committed: RunEventDelivery[] = [];
    stream.subscribe((d) => local.push(d), { includeUncommitted: true });
    stream.subscribe((d) => committed.push(d));

    stream.emit(goalEcho());

    expect(local).toEqual([{ seq: null, committed: false, event: goalEcho() }]);
    expect(committed).toEqual([]);
  });

  it('commits pre-open events as seq 1..n on open, keeping `at`, without re-delivering locally', async () => {
    const runDir = await makeRunDir();
    const stream = new RunEventStream();
    const local: RunEventDelivery[] = [];
    const committed: RunEventDelivery[] = [];
    stream.subscribe((d) => local.push(d), { includeUncommitted: true });
    stream.subscribe((d) => committed.push(d));
    const early = { ...goalEcho(), at: '2026-01-01T00:00:00.000Z' };
    stream.emit(early);
    stream.emit({ kind: 'run_warning', source: 'command', text: 'careful', at: AT });

    openStream(stream, runDir);
    stream.emit(taskStarted());
    stream.close();

    expect(local.map((d) => [d.event.kind, d.seq])).toEqual([
      ['goal_echo', null],
      ['run_warning', null],
      ['task_started', 3],
    ]);
    expect(committed.map((d) => [d.event.kind, d.seq, d.committed])).toEqual([
      ['goal_echo', 1, true],
      ['run_warning', 2, true],
      ['task_started', 3, true],
    ]);
    const items = (await readAll(join(runDir, RUN_EVENTS_FILENAME))) as {
      record: { seq: number; event: { at: string } };
    }[];
    expect(items[0]?.record.event.at).toBe('2026-01-01T00:00:00.000Z');
  });

  it(`keeps the newest ${PRE_OPEN_BUFFER_LIMIT} pre-open events and logs the overflow`, async () => {
    const runDir = await makeRunDir();
    const logger = recordingLogger();
    const stream = new RunEventStream({ logger });
    for (let i = 0; i < PRE_OPEN_BUFFER_LIMIT + 5; i++) stream.emit(assistantText(`t${i}`));

    openStream(stream, runDir);
    stream.close();

    const items = (await readAll(join(runDir, RUN_EVENTS_FILENAME))) as {
      record: { event: { text: string } };
    }[];
    expect(items).toHaveLength(PRE_OPEN_BUFFER_LIMIT);
    expect(items[0]?.record.event.text).toBe('t5');
    expect(logger.warn).toHaveBeenCalledWith(
      { event: 'run_events_preopen_overflow', dropped: 5 },
      'run_events_preopen_overflow',
    );
  });

  it('writes nothing when closed before it ever opened (a run that never started)', async () => {
    const runDir = await makeRunDir();
    const stream = new RunEventStream();
    stream.emit(goalEcho());
    stream.close();

    expect(existsSync(join(runDir, RUN_EVENTS_FILENAME))).toBe(false);
    expect(stream.closed).toBe(true);
  });

  it('refuses a second open', async () => {
    const runDir = await makeRunDir();
    const stream = new RunEventStream();
    openStream(stream, runDir);

    expect(() => openStream(stream, runDir)).toThrow(/state open/);
    stream.close();
  });

  it('propagates an open failure as RUN_EVENT_LOG_OPEN_FAILED and stays pre-open', async () => {
    const runDir = await makeRunDir();
    const stream = new RunEventStream();

    expect(() => stream.open({ runDir: join(runDir, 'missing', '\u0000bad'), runId: 'r' })).toThrow(
      expect.objectContaining({ code: 'RUN_EVENT_LOG_OPEN_FAILED' }),
    );
    expect(stream.opened).toBe(false);
  });
});

describe('@no-llm RunEventStream subscribers', () => {
  it('isolates a throwing listener: others keep receiving and it is logged once', async () => {
    const runDir = await makeRunDir();
    const logger = recordingLogger();
    const stream = new RunEventStream({ logger });
    openStream(stream, runDir);
    stream.subscribe(() => {
      throw new TypeError('boom');
    });
    const healthy: string[] = [];
    stream.subscribe((d) => healthy.push(d.event.kind));

    stream.emit(taskStarted());
    stream.emit(assistantText('a'));
    stream.close();

    expect(healthy).toEqual(['task_started', 'assistant_text']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { event: 'run_events_listener_failed', listener_index: 0, error_class: 'TypeError' },
      'run_events_listener_failed',
    );
    expect(await readSeqs(join(runDir, RUN_EVENTS_FILENAME))).toEqual([1, 2]);
  });

  it('returns an idempotent disposer', async () => {
    const runDir = await makeRunDir();
    const stream = new RunEventStream();
    openStream(stream, runDir);
    const seen: string[] = [];
    const dispose = stream.subscribe((d) => seen.push(d.event.kind));
    stream.emit(taskStarted());
    dispose();
    dispose();
    stream.emit(assistantText('after'));
    stream.close();

    expect(seen).toEqual(['task_started']);
  });
});

describe('@no-llm RunEventStream degraded mode', () => {
  function failingWriterStream(logger: ReturnType<typeof recordingLogger>, failAfter: number) {
    const stream = new RunEventStream({ logger });
    return {
      stream,
      open: (runDir: string) =>
        stream.open({
          runDir,
          runId: 'run-1',
          sync: () => undefined,
          scheduler: new ManualScheduler(),
          openLog: (options) => {
            const log = RunEventLog.open(options);
            let appended = 0;
            const append = log.append.bind(log);
            vi.spyOn(log, 'append').mockImplementation((event) => {
              if (appended++ >= failAfter) {
                throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
              }
              return append(event);
            });
            return log;
          },
        }),
    };
  }

  it('keeps local delivery, stops committed delivery, and logs once', async () => {
    const runDir = await makeRunDir();
    const logger = recordingLogger();
    const { stream, open } = failingWriterStream(logger, 1);
    open(runDir);
    const local: RunEventDelivery[] = [];
    const committed: RunEventDelivery[] = [];
    stream.subscribe((d) => local.push(d), { includeUncommitted: true });
    stream.subscribe((d) => committed.push(d));

    stream.emit(taskStarted());
    stream.emit(assistantText('lost to disk'));
    stream.emit(assistantText('still shown'));
    stream.close();

    expect(stream.degraded).toBe(false); // closed now
    expect(local.map((d) => [d.event.kind, d.seq, d.committed])).toEqual([
      ['task_started', 1, true],
      ['assistant_text', null, false],
      ['assistant_text', null, false],
    ]);
    expect(committed.map((d) => d.seq)).toEqual([1]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { event: 'run_events_degraded', code: 'ENOSPC' },
      'run_events_degraded',
    );
    expect(await readSeqs(join(runDir, RUN_EVENTS_FILENAME))).toEqual([1]);
  });

  it('degrades while committing the pre-open buffer, without losing local output', async () => {
    const runDir = await makeRunDir();
    const logger = recordingLogger();
    const { stream, open } = failingWriterStream(logger, 0);
    const local: string[] = [];
    stream.subscribe((d) => local.push(d.event.kind), { includeUncommitted: true });
    stream.emit(goalEcho());

    open(runDir);
    expect(stream.degraded).toBe(true);
    stream.emit(assistantText('a'));
    stream.close();

    expect(local).toEqual(['goal_echo', 'assistant_text']);
  });

  it('drops an invalid event from the log but still shows it locally', async () => {
    const runDir = await makeRunDir();
    const logger = recordingLogger();
    const stream = new RunEventStream({ logger });
    openStream(stream, runDir);
    const local: RunEventDelivery[] = [];
    const committed: RunEventDelivery[] = [];
    stream.subscribe((d) => local.push(d), { includeUncommitted: true });
    stream.subscribe((d) => committed.push(d));

    const bad = { kind: 'run_warning', source: 'agent', text: 'a\u001bb', at: AT } as const;
    stream.emit(bad);
    stream.emit(bad);
    stream.emit(taskStarted());
    stream.close();

    expect(local.map((d) => d.seq)).toEqual([null, null, 1]);
    expect(committed.map((d) => d.seq)).toEqual([1]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { event: 'run_events_invalid', kind: 'run_warning' },
      'run_events_invalid',
    );
    expect(stream.degraded).toBe(false);
  });

  it('rethrows a duplicate run_outcome to the producer', async () => {
    const runDir = await makeRunDir();
    const stream = new RunEventStream();
    openStream(stream, runDir);
    stream.emit(runOutcome());

    expect(() => stream.emit(runOutcome())).toThrow(
      expect.objectContaining({ code: 'RUN_OUTCOME_DUPLICATE' }),
    );
    stream.close();
  });
});

describe('@no-llm RunEventStream close', () => {
  it('drops an emit after close and logs once per kind', async () => {
    const runDir = await makeRunDir();
    const logger = recordingLogger();
    const stream = new RunEventStream({ logger });
    openStream(stream, runDir);
    const seen: string[] = [];
    stream.subscribe((d) => seen.push(d.event.kind), { includeUncommitted: true });
    stream.close();

    stream.emit(assistantText('a'));
    stream.emit(assistantText('b'));
    stream.emit(taskStarted());

    expect(seen).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      { event: 'run_events_after_close', kind: 'assistant_text' },
      'run_events_after_close',
    );
  });

  it('close is idempotent and syncs the log', async () => {
    const runDir = await makeRunDir();
    const sync = vi.fn();
    const stream = new RunEventStream();
    stream.open({ runDir, runId: 'run-1', sync, scheduler: new ManualScheduler() });
    stream.emit(assistantText('a'));
    stream.close();
    stream.close();

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('exposes the run id and path once open', async () => {
    const runDir = await makeRunDir();
    const stream = new RunEventStream();
    expect(stream.runId).toBeNull();
    openStream(stream, runDir);

    expect(stream.runId).toBe('run-1');
    expect(stream.path).toBe(join(runDir, RUN_EVENTS_FILENAME));
    stream.close();
  });
});

describe('@no-llm MirroringEventBus', () => {
  const taskEvents: TaskEvent[] = [
    { kind: 'task_started', task_id: 't', at: AT },
    { kind: 'step_started', task_id: 't', at: AT, step_id: 's1', step_type: 'navigate' },
    { kind: 'step_completed', task_id: 't', at: AT, step_id: 's1', capture_keys: ['title'] },
    { kind: 'task_completed', task_id: 't', at: AT, outputs_keys: [] },
  ];

  it('writes the identical events to events.jsonl and run-events.jsonl', async () => {
    const runDir = await makeRunDir();
    const stream = new RunEventStream();
    openStream(stream, runDir);
    const bus = openTaskEventBus(runDir, stream);

    for (const event of taskEvents) bus.publish(event);
    await bus.close();
    stream.close();

    const legacy = readFileSync(join(runDir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as unknown);
    const mirrored = (
      (await readAll(join(runDir, RUN_EVENTS_FILENAME))) as {
        record: { event: unknown };
      }[]
    ).map((item) => item.record.event);
    expect(legacy).toEqual(taskEvents);
    expect(mirrored).toEqual(taskEvents);
  });

  it('leaves events.jsonl byte-identical to what JsonlEventBus alone writes', async () => {
    const alone = await makeRunDir();
    const plain = new JsonlEventBus(join(alone, 'events.jsonl'));
    for (const event of taskEvents) plain.publish(event);
    await plain.close();

    const mirroredDir = await makeRunDir();
    const stream = new RunEventStream();
    openStream(stream, mirroredDir);
    const bus = openTaskEventBus(mirroredDir, stream);
    for (const event of taskEvents) bus.publish(event);
    await bus.close();
    stream.close();

    expect(readFileSync(join(mirroredDir, 'events.jsonl'))).toEqual(
      readFileSync(join(alone, 'events.jsonl')),
    );
  });

  it('drops publishes after close from both files, as JsonlEventBus does', async () => {
    const runDir = await makeRunDir();
    const stream = new RunEventStream();
    openStream(stream, runDir);
    const bus = openTaskEventBus(runDir, stream);
    bus.publish(taskEvents[0]!);
    await bus.close();
    bus.publish(taskEvents[1]!);
    stream.emit(runOutcome());
    stream.close();

    expect(await readSeqs(join(runDir, RUN_EVENTS_FILENAME))).toEqual([1, 2]);
  });

  it('delegates flush and persistedAt, and does not close the stream', async () => {
    const runDir = await makeRunDir();
    const stream = new RunEventStream();
    openStream(stream, runDir);
    const inner = new JsonlEventBus(join(runDir, 'events.jsonl'));
    const flush = vi.spyOn(inner, 'flush');
    const bus = new MirroringEventBus(inner, stream);

    await bus.flush();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(bus.persistedAt()).toBe(join(runDir, 'events.jsonl'));
    await bus.close();
    expect(stream.closed).toBe(false);
    stream.close();
  });

  it('is a plain JsonlEventBus when no stream is given', async () => {
    const runDir = await makeRunDir();

    expect(openTaskEventBus(runDir, null)).toBeInstanceOf(JsonlEventBus);
    expect(openTaskEventBus(runDir, undefined)).toBeInstanceOf(JsonlEventBus);
  });
});
