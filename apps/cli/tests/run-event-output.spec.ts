// @no-llm
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { ResourceBusyError, RunEventLogError, RunEventStream } from '@yantra/core';
import { GOAL_ECHO_DISPLAY_MAX, RunEvent, type RunEventDelivery } from '@yantra/protocol';
import { CommanderError } from 'commander';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import { CommandConnectorIO } from '../src/connector-io.js';
import { CommandFailure } from '../src/context/command-context.js';
import { goalEchoEvent, renderGoalEcho } from '../src/render/goal-echo.js';
import { TerminalRenderer } from '../src/render/terminal.js';
import type { ConnectorRenderOpts } from '../src/render/types.js';
import {
  createLiveRunEvents,
  exitCodeOfThrown,
  finishRunEvents,
  warningEvent,
} from '../src/run-event-output.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function sinks() {
  const out = { stdout: '', stderr: '' };
  const renderOpts: ConnectorRenderOpts = {
    json: false,
    debug: false,
    noColor: true,
    stream: new Writable({
      write(chunk, _e, cb) {
        out.stdout += String(chunk);
        cb();
      },
    }),
    errStream: new Writable({
      write(chunk, _e, cb) {
        out.stderr += String(chunk);
        cb();
      },
    }),
  };
  return { out, renderOpts };
}

async function runDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yantra-cli-run-events-'));
  dirs.push(dir);
  return dir;
}

describe('@no-llm goalEchoEvent', () => {
  it('is the echo line without its newline, plus what was received', () => {
    const event = goalEchoEvent('buy "2" widgets', '2026-11-01T00:00:00.000Z');

    expect(event).toEqual({
      kind: 'goal_echo',
      display: 'goal: "buy \\"2\\" widgets"',
      received_chars: 15,
      truncated: false,
      at: '2026-11-01T00:00:00.000Z',
    });
    expect(renderGoalEcho('buy "2" widgets')).toBe(`${event.display}\n`);
  });

  it('marks a long goal truncated and counts every received character', () => {
    const event = goalEchoEvent('x'.repeat(250));

    expect(event.truncated).toBe(true);
    expect(event.received_chars).toBe(250);
    expect(event.display.endsWith('(250 characters received)')).toBe(true);
  });

  it('never shows a malformed marker raw', () => {
    expect(goalEchoEvent('find @{secret').display).toBe(
      'goal: [not shown: the goal has a malformed @{...} marker]',
    );
  });

  it('fits the protocol bound even in the worst case: 200 escaped quotes', () => {
    const event = goalEchoEvent('"'.repeat(5000));

    expect(event.display.length).toBeLessThanOrEqual(GOAL_ECHO_DISPLAY_MAX);
    expect(RunEvent.safeParse(event).success).toBe(true);
  });

  it('is always a schema-valid event (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (goal) => {
        let event;
        try {
          event = goalEchoEvent(goal);
        } catch {
          return; // a goal the redactor rejects is a command error, not an echo
        }
        expect(RunEvent.safeParse(event).success).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe('@no-llm warningEvent and exit codes', () => {
  it('builds a control-free, bounded run_warning', () => {
    const event = warningEvent('command', 'a\u001b[2Jb\n'.concat('c'.repeat(2000)));

    expect(event.kind).toBe('run_warning');
    expect(event.text.length).toBe(1000);
    expect(RunEvent.safeParse(event).success).toBe(true);
  });

  it('maps rethrown errors to the exit code the command returns', () => {
    expect(exitCodeOfThrown(new CommanderError(4, 'x', 'y'))).toBe(4);
    expect(exitCodeOfThrown(new CommandFailure(1, 'x', 'y'))).toBe(1);
    expect(exitCodeOfThrown(new ResourceBusyError({ kind: 'config' }, null))).toBe(3);
    expect(exitCodeOfThrown(new RunEventLogError('RUN_EVENT_LOG_OPEN_FAILED', 'x'))).toBe(3);
    expect(exitCodeOfThrown(new Error('x'))).toBe(2);
  });
});

describe('@no-llm finishRunEvents', () => {
  it('records the command’s outcome when the run threw after the log opened', async () => {
    const dir = await runDir();
    const stream = new RunEventStream();
    stream.open({ runDir: dir, runId: 'run-1' });

    finishRunEvents(stream, 1);

    const lines = (await readFile(join(dir, 'run-events.jsonl'), 'utf8')).trim().split('\n');
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({
      event: { kind: 'run_outcome', run_id: 'run-1', task_outcome: 'failed', exit_code: 1 },
    });
    expect(stream.closed).toBe(true);
  });

  it.each([
    [0, 'fulfilled', null],
    [4, 'handoff', null],
    [130, 'aborted', 'unexpected'],
    [3, 'failed', 'unexpected'],
  ] as const)('maps exit %i to %s', async (code, word, failureClass) => {
    const dir = await runDir();
    const stream = new RunEventStream();
    stream.open({ runDir: dir, runId: 'run-1' });
    const seen: RunEventDelivery[] = [];
    stream.subscribe((d) => seen.push(d));

    finishRunEvents(stream, code);

    expect(seen.at(-1)?.event).toMatchObject({
      task_outcome: word,
      exit_code: code,
      failure_class: failureClass,
    });
  });

  it('adds nothing when the run recorded its own outcome, and closes', async () => {
    const dir = await runDir();
    const stream = new RunEventStream();
    stream.open({ runDir: dir, runId: 'run-1' });
    stream.emit({
      kind: 'run_outcome',
      run_id: 'run-1',
      task_outcome: 'fulfilled',
      termination_reason: null,
      stop_detail: null,
      exit_code: 0,
      failure_class: null,
      at: '2026-11-01T00:00:00.000Z',
    });

    finishRunEvents(stream, 2);

    const lines = (await readFile(join(dir, 'run-events.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(stream.closed).toBe(true);
  });

  it('just closes a stream that never opened (no run existed)', () => {
    const stream = new RunEventStream();
    finishRunEvents(stream, 1);

    expect(stream.closed).toBe(true);
  });
});

describe('@no-llm connector and stream', () => {
  it('renders agent events through the stream exactly once', () => {
    const { out, renderOpts } = sinks();
    const connector = new CommandConnectorIO(new TerminalRenderer(), {
      renderOpts,
      interactive: false,
    });

    connector.emitAgentEvent({
      type: 'assistant_text',
      text: 'hi',
      at: '2026-11-01T00:00:00.000Z',
    });
    connector.emitAgentWarning('careful');

    expect(out).toEqual({ stdout: 'hi', stderr: 'warning: careful\n' });
  });

  it('does not subscribe a second renderer to a stream the command already renders', () => {
    const { out, renderOpts } = sinks();
    const stream = createLiveRunEvents(renderOpts);
    const connector = new CommandConnectorIO(new TerminalRenderer(), {
      renderOpts,
      interactive: false,
      runEvents: stream,
    });

    expect(connector.runEvents).toBe(stream);
    connector.emitAgentEvent({
      type: 'assistant_text',
      text: 'once',
      at: '2026-11-01T00:00:00.000Z',
    });
    expect(out.stdout).toBe('once');
  });

  it('gives onEvent committed deliveries only, with their seq', async () => {
    const dir = await runDir();
    const { renderOpts } = sinks();
    const connector = new CommandConnectorIO(new TerminalRenderer(), {
      renderOpts,
      interactive: false,
    });
    const seen: RunEventDelivery[] = [];
    const dispose = connector.onEvent((d) => seen.push(d));

    connector.runEvents.emit(goalEchoEvent('x'));
    expect(seen).toEqual([]);
    connector.runEvents.open({ runDir: dir, runId: 'run-1' });
    connector.emitAgentEvent({ type: 'assistant_text', text: 'a', at: '2026-11-01T00:00:00.000Z' });
    dispose();
    dispose();
    connector.runEvents.close();

    expect(seen.map((d) => [d.event.kind, d.seq, d.committed])).toEqual([
      ['goal_echo', 1, true],
      ['assistant_text', 2, true],
    ]);
  });

  it('renders nothing for a result-only connector (no agent options)', () => {
    const connector = new CommandConnectorIO(new TerminalRenderer());

    expect(() => connector.runEvents.emit(goalEchoEvent('x'))).not.toThrow();
    expect(() =>
      connector.emitAgentEvent({
        type: 'assistant_text',
        text: 'a',
        at: '2026-11-01T00:00:00.000Z',
      }),
    ).toThrow(/requires render options/);
  });
});
