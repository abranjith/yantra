// @no-llm
/**
 * The terminal and `--json` projections of the run-event union (FEAT-063
 * TASK-010): one case per kind, a runtime table check that the switches cover
 * `RUN_EVENT_KINDS` exactly (tests are not typechecked), and the byte shapes
 * the live-output goldens pin end to end.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  RUN_EVENT_KINDS,
  SCHEMA_VERSION,
  type RunEventKind,
  type RunEventType,
} from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { JSON_PRINTING_KINDS, renderRunEventJson } from '../../src/render/run-event-json.js';
import {
  TERMINAL_PRINTING_KINDS,
  assertNever,
  renderRunEventTerminal,
} from '../../src/render/run-event-terminal.js';

const FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'protocol',
  'tests',
  'fixtures',
  'run-events',
  'new-values',
);

function fixtureEvent(kind: RunEventKind): RunEventType {
  return (
    JSON.parse(readFileSync(join(FIXTURES, `${kind}.json`), 'utf8')) as { event: RunEventType }
  ).event;
}

interface Captured {
  stdout: string;
  stderr: string;
  lines: unknown[];
}

function terminal(event: RunEventType): Captured {
  const out: Captured = { stdout: '', stderr: '', lines: [] };
  renderRunEventTerminal(event, {
    stream: { write: (chunk: string) => ((out.stdout += chunk), true) },
    errStream: { write: (chunk: string) => ((out.stderr += chunk), true) },
  });
  return out;
}

function json(event: RunEventType): Captured {
  const out: Captured = { stdout: '', stderr: '', lines: [] };
  renderRunEventJson(event, {
    jsonLine: (value) => out.lines.push(value),
    errStream: { write: (chunk: string) => ((out.stderr += chunk), true) },
  });
  return out;
}

const printed = (c: Captured): boolean =>
  c.stdout.length > 0 || c.stderr.length > 0 || c.lines.length > 0;

describe('@no-llm run-event projections cover the union exactly', () => {
  it.each(RUN_EVENT_KINDS)('the terminal projection maps %s without throwing', (kind) => {
    const out = terminal(fixtureEvent(kind));
    expect(printed(out)).toBe(TERMINAL_PRINTING_KINDS.includes(kind));
  });

  it.each(RUN_EVENT_KINDS)('the JSON projection maps %s without throwing', (kind) => {
    const out = json(fixtureEvent(kind));
    expect(printed(out)).toBe(JSON_PRINTING_KINDS.includes(kind));
  });

  it('prints exactly the declared kinds, all of which are union kinds', () => {
    const terminalPrinting = RUN_EVENT_KINDS.filter((k) => printed(terminal(fixtureEvent(k))));
    const jsonPrinting = RUN_EVENT_KINDS.filter((k) => printed(json(fixtureEvent(k))));

    expect([...terminalPrinting].sort()).toEqual([...TERMINAL_PRINTING_KINDS].sort());
    expect([...jsonPrinting].sort()).toEqual([...JSON_PRINTING_KINDS].sort());
  });

  it('refuses a kind it does not know (the assertNever default)', () => {
    const unknown = { kind: 'attendance_changed', at: '2026-11-01T00:00:00.000Z' } as never;

    expect(() =>
      renderRunEventTerminal(unknown, { stream: process.stdout, errStream: process.stderr }),
    ).toThrow(/Unmapped run event kind: attendance_changed/);
    expect(() =>
      renderRunEventJson(unknown, { jsonLine: () => undefined, errStream: process.stderr }),
    ).toThrow(/attendance_changed/);
    expect(() => assertNever({ kind: 'x' } as never)).toThrow('Unmapped run event kind: x');
  });
});

describe('@no-llm terminal projection bytes', () => {
  const at = '2026-11-01T00:00:00.000Z';

  it.each([
    [
      { kind: 'goal_echo', display: 'goal: "x"', received_chars: 1, truncated: false, at },
      '',
      'goal: "x"\n',
    ],
    [{ kind: 'run_warning', source: 'agent', text: 'careful', at }, '', 'warning: careful\n'],
    [{ kind: 'run_warning', source: 'command', text: 'careful', at }, '', 'warning: careful\n'],
    [{ kind: 'assistant_text', text: 'raw\ttext', at }, 'raw\ttext', ''],
    [
      { kind: 'tool_started', tool: 'web_fetch', summary: 'fields: url', at },
      '\n[web_fetch] fields: url\n',
      '',
    ],
    [
      { kind: 'tool_finished', tool: 'web_fetch', summary: 'ok', status: 'ok', durationMs: 12, at },
      '[web_fetch] ok — ok (12ms)\n',
      '',
    ],
    [
      {
        kind: 'tool_finished',
        tool: 'web_fetch',
        summary: 'x',
        status: 'error',
        durationMs: null,
        at,
      },
      '[web_fetch] error — x\n',
      '',
    ],
    [{ kind: 'contract_declared', revision: 1, summary: 'a  b', at }, '', 'understood: a b\n'],
    [{ kind: 'contract_declared', revision: 3, summary: 'c', at }, '', 'understood (revised): c\n'],
    [{ kind: 'progress', items: [], summary: 'one', at }, '', 'progress: one\n'],
    [
      { kind: 'recovery', rung: 'stop', trigger: 'stalled', move: null, summary: 'stop', at },
      '',
      'recovery: stop\n',
    ],
    [
      { kind: 'capability_gap', item: 'i', reason: 'no_browser', summary: 'Cannot deliver.', at },
      '',
      'Cannot deliver.\n',
    ],
  ] as const)('renders %o', (event, stdout, stderr) => {
    expect(terminal(event as RunEventType)).toEqual({ stdout, stderr, lines: [] });
  });

  it('strips control characters from summaries, as before', () => {
    const out = terminal({
      kind: 'contract_declared',
      revision: 1,
      summary: 'table of \u001b[31mred\u001b[0m cars\nnext',
      at,
    });

    expect(out.stderr).toBe('understood: table of [31mred [0m cars next\n');
  });
});

describe('@no-llm JSON projection bytes', () => {
  const at = '2026-11-01T00:00:00.000Z';

  it('writes agent kinds as agent_progress lines with the connector-shaped event', () => {
    const out = json({
      kind: 'tool_finished',
      tool: 'web_fetch',
      summary: 'ok',
      status: 'ok',
      durationMs: 3,
      at,
    });

    expect(out.lines).toEqual([
      {
        schemaVersion: SCHEMA_VERSION,
        kind: 'agent_progress',
        event: {
          type: 'tool_finished',
          tool: 'web_fetch',
          summary: 'ok',
          status: 'ok',
          durationMs: 3,
          at,
        },
      },
    ]);
    expect(JSON.stringify(out.lines[0])).toBe(
      `{"schemaVersion":"${SCHEMA_VERSION}","kind":"agent_progress","event":{"type":"tool_finished","tool":"web_fetch","summary":"ok","status":"ok","durationMs":3,"at":"${at}"}}`,
    );
  });

  it('keeps the goal echo and command advisories on stderr, and suppresses agent advisories', () => {
    expect(
      json({ kind: 'goal_echo', display: 'goal: "x"', received_chars: 1, truncated: false, at }),
    ).toEqual({ stdout: '', stderr: 'goal: "x"\n', lines: [] });
    expect(json({ kind: 'run_warning', source: 'command', text: 'w', at })).toEqual({
      stdout: '',
      stderr: 'warning: w\n',
      lines: [],
    });
    expect(printed(json({ kind: 'run_warning', source: 'agent', text: 'w', at }))).toBe(false);
  });
});
