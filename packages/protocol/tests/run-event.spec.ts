// @no-llm
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  AGENT_PROGRESS_KINDS,
  AgentProgressEvent,
  BUDGET_DIMENSIONS_MAX,
  GOAL_ECHO_DISPLAY_MAX,
  INTERVENTION_EVENT_KINDS,
  MAX_RUN_EVENT_LINE_BYTES,
  RUN_EVENTS_SCHEMA_VERSION,
  RUN_EVENT_KINDS,
  RunEvent,
  RunEventRecord,
  TERMINAL_EVENT_KINDS,
  TaskEvent,
  isAgentProgressRunEvent,
  isRunEventKind,
  parseRunEventLine,
  toAgentProgressEvent,
  toRunEvent,
  type AgentProgressEventType,
  type RunEventKind,
  type RunEventType,
} from '../src/index.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'run-events');
const at = '2026-11-01T12:00:00.000Z';

function fixture(kind: string): {
  schema_version: string;
  seq: number;
  run_id: string;
  event: Record<string, unknown>;
} {
  return JSON.parse(
    readFileSync(join(FIXTURES, 'new-values', `${kind}.json`), 'utf8'),
  ) as ReturnType<typeof fixture>;
}

function record(event: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema_version: '1', seq: 1, run_id: 'run', event, ...overrides });
}

function eventOf(kind: RunEventKind, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...fixture(kind).event, ...patch };
}

const unionKinds = (): string[] => RunEvent.options.map((option) => option.shape.kind.value);

describe('@no-llm RunEvent union', () => {
  it('RUN_EVENT_KINDS equals the union discriminator values, in order', () => {
    expect([...RUN_EVENT_KINDS]).toEqual(unionKinds());
    expect(new Set(RUN_EVENT_KINDS).size).toBe(RUN_EVENT_KINDS.length);
  });

  it('spreads every TaskEvent kind in unchanged', () => {
    const taskKinds = TaskEvent.options.map((option) => option.shape.kind.value);

    expect(unionKinds().slice(0, taskKinds.length)).toEqual(taskKinds);
  });

  it('carries every agent progress kind', () => {
    expect(RUN_EVENT_KINDS).toEqual(expect.arrayContaining([...AGENT_PROGRESS_KINDS]));
  });

  it('every variant has an ISO-8601 `at`', () => {
    for (const option of RunEvent.options) {
      expect(Object.keys(option.shape)).toContain('at');
    }
  });

  it('intervention and terminal kinds are known kinds', () => {
    for (const kind of [...INTERVENTION_EVENT_KINDS, ...TERMINAL_EVENT_KINDS]) {
      expect(isRunEventKind(kind)).toBe(true);
    }
  });

  it.each(RUN_EVENT_KINDS)('parses the %s fixture as an event', (kind) => {
    const item = parseRunEventLine(JSON.stringify(fixture(kind)));

    expect(item.status).toBe('event');
    expect(item.status === 'event' && item.record.event.kind).toBe(kind);
  });

  it('keeps every fixture record unchanged through the schema', () => {
    for (const kind of RUN_EVENT_KINDS) {
      const raw = fixture(kind);
      expect(RunEventRecord.parse(raw)).toEqual(raw);
    }
  });
});

describe('@no-llm RunEvent bounds', () => {
  const fails = (kind: RunEventKind, patch: Record<string, unknown>): boolean =>
    parseRunEventLine(record(eventOf(kind, patch))).status === 'invalid';

  it('rejects a goal_echo display over its bound and accepts one at it', () => {
    expect(fails('goal_echo', { display: 'g'.repeat(GOAL_ECHO_DISPLAY_MAX + 1) })).toBe(true);
    expect(fails('goal_echo', { display: 'g'.repeat(GOAL_ECHO_DISPLAY_MAX) })).toBe(false);
  });

  it('rejects control characters in stored text', () => {
    expect(fails('goal_echo', { display: 'goal: "a\u001b[2Jb"' })).toBe(true);
    expect(fails('run_warning', { text: 'line one\nline two' })).toBe(true);
    expect(fails('search_completed', { query: 'tab\there' })).toBe(true);
  });

  it.each([
    ['../escape.png', 'a `..` segment'],
    ['screenshots/../../x.png', 'a nested `..` segment'],
    ['/etc/passwd', 'a leading slash'],
    ['screenshots\\capture.png', 'a backslash'],
    ['C:/runs/x.png', 'a drive letter'],
    ['', 'an empty path'],
  ])('rejects artifact_saved.path %j (%s)', (path) => {
    expect(fails('artifact_saved', { path })).toBe(true);
  });

  it('accepts nested run-relative artifact paths', () => {
    expect(fails('artifact_saved', { path: 'screenshots/capture-1-abc.png' })).toBe(false);
    expect(fails('artifact_saved', { path: 'a..b/c.png' })).toBe(false);
  });

  it('rejects budget_snapshot with more than 16 dimensions', () => {
    const dimension = { name: 'tool_calls', used: 1, limit: null, unit: 'count' };

    expect(
      fails('budget_snapshot', {
        dimensions: Array.from({ length: BUDGET_DIMENSIONS_MAX + 1 }, () => dimension),
      }),
    ).toBe(true);
    expect(
      fails('budget_snapshot', {
        dimensions: Array.from({ length: BUDGET_DIMENSIONS_MAX }, () => dimension),
      }),
    ).toBe(false);
  });

  it('rejects a non-snake_case budget dimension name and a negative amount', () => {
    expect(
      fails('budget_snapshot', {
        dimensions: [{ name: 'Tool Calls', used: 1, limit: 2, unit: 'count' }],
      }),
    ).toBe(true);
    expect(
      fails('budget_snapshot', {
        dimensions: [{ name: 'hosts', used: -1, limit: 2, unit: 'count' }],
      }),
    ).toBe(true);
  });

  it('accepts the first-run and resume receipt files and rejects anything else', () => {
    expect(fails('receipt_written', { path: 'execution-receipt.resume-2.json' })).toBe(false);
    expect(fails('receipt_written', { path: 'execution-receipt.resume-0.json' })).toBe(true);
    expect(fails('receipt_written', { path: '../execution-receipt.json' })).toBe(true);
    expect(fails('receipt_written', { sha256: 'AB'.repeat(32) })).toBe(true);
    expect(fails('receipt_written', { sha256: 'ab'.repeat(31) })).toBe(true);
  });

  it('bounds phase-event query and url', () => {
    expect(fails('search_completed', { query: 'q'.repeat(201) })).toBe(true);
    expect(fails('source_fetched', { url: `https://e.example/${'p'.repeat(300)}` })).toBe(true);
    expect(fails('source_fetched', { source_index: 0 })).toBe(true);
    expect(fails('search_completed', { hop_index: 0 })).toBe(true);
  });

  it('allows a null termination reason and stop detail on run_outcome, and validates both', () => {
    expect(fails('run_outcome', { termination_reason: null, stop_detail: 'coverage_met' })).toBe(
      false,
    );
    expect(fails('run_outcome', { termination_reason: 'owner_lost' })).toBe(false);
    expect(fails('run_outcome', { stop_detail: 'Coverage Met' })).toBe(true);
    expect(fails('run_outcome', { exit_code: 1.5 })).toBe(true);
  });

  it('accepts the app decider on intervention_resolved but no agent decider', () => {
    expect(fails('intervention_resolved', { decided_by: 'user_app' })).toBe(false);
    expect(fails('intervention_resolved', { decided_by: 'agent' })).toBe(true);
  });

  it('keeps the line cap at 256 KiB', () => {
    expect(MAX_RUN_EVENT_LINE_BYTES).toBe(262_144);
  });
});

describe('@no-llm parseRunEventLine', () => {
  it('rejects seq 0 and a negative seq', () => {
    expect(parseRunEventLine(record(eventOf('task_started'), { seq: 0 })).status).toBe('invalid');
    expect(parseRunEventLine(record(eventOf('task_started'), { seq: -3 })).status).toBe('invalid');
  });

  it('treats an unknown envelope version as invalid', () => {
    const item = parseRunEventLine(record(eventOf('task_started'), { schema_version: '2' }));

    expect(item).toMatchObject({ status: 'invalid', reason: expect.stringContaining('envelope') });
    expect(RUN_EVENTS_SCHEMA_VERSION).toBe('1');
  });

  it('reports a newer writer’s kind as unknown_kind, never an error', () => {
    const raw = readFileSync(join(FIXTURES, 'newer-writer.unknown-kind.json'), 'utf8');
    const item = parseRunEventLine(JSON.stringify(JSON.parse(raw)));

    expect(item).toEqual({
      status: 'unknown_kind',
      seq: 7,
      kind: 'attendance_changed',
      raw: { kind: 'attendance_changed', attended: 2, at },
    });
  });

  it('reports a line that is not JSON as invalid with a bounded excerpt', () => {
    const item = parseRunEventLine(`{"schema_version":"1","seq":${'9'.repeat(400)}`);

    expect(item.status).toBe('invalid');
    expect(item.status === 'invalid' && item.line.length).toBeLessThanOrEqual(201);
  });

  it('reports a known kind with bad fields as invalid, naming the field', () => {
    const item = parseRunEventLine(record(eventOf('tool_finished', { status: 'exploded' })));

    expect(item).toMatchObject({ status: 'invalid', reason: expect.stringContaining('status') });
  });

  it('reports an envelope without an event kind as invalid', () => {
    expect(parseRunEventLine(record({ at })).status).toBe('invalid');
    expect(parseRunEventLine('[]').status).toBe('invalid');
    expect(parseRunEventLine('null').status).toBe('invalid');
  });
});

/** Arbitrary agent progress events in the exact key order the runtime emits. */
const text = fc.string({ maxLength: 120 });
const agentEventArb: fc.Arbitrary<AgentProgressEventType> = fc.oneof(
  fc.record({
    type: fc.constant('recovery' as const),
    rung: fc.constantFrom('steer' as const, 'freeze' as const, 'stop' as const),
    trigger: fc.constantFrom('stalled' as const, 'turn-timeout' as const),
    move: fc.constantFrom(
      'fill-remaining' as const,
      'list-fields' as const,
      'capture' as const,
      'publish' as const,
      null,
    ),
    summary: text,
    at: fc.constant(at),
  }),
  fc.record({
    type: fc.constant('progress' as const),
    items: fc.array(
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 30 }),
        kind: fc.constantFrom(
          'fill' as const,
          'artifact' as const,
          'effects' as const,
          'deliverable' as const,
        ),
        label: fc.string({ maxLength: 60 }),
        state: fc.constantFrom('pending' as const, 'advancing' as const, 'met' as const),
        done: fc.option(fc.nat(50)),
        total: fc.option(fc.nat(50)),
      }),
      { maxLength: 6 },
    ),
    summary: fc.string({ maxLength: 160 }),
    at: fc.constant(at),
  }),
  fc.record({ type: fc.constant('assistant_text' as const), text, at: fc.constant(at) }),
  fc.record({
    type: fc.constant('tool_started' as const),
    tool: fc.string({ minLength: 1, maxLength: 30 }),
    summary: text,
    at: fc.constant(at),
  }),
  fc.record({
    type: fc.constant('tool_finished' as const),
    tool: fc.string({ minLength: 1, maxLength: 30 }),
    summary: text,
    status: fc.constantFrom('ok' as const, 'error' as const, 'denied' as const, 'aborted' as const),
    durationMs: fc.option(fc.nat(100_000)),
    at: fc.constant(at),
  }),
  fc.record({
    type: fc.constant('contract_declared' as const),
    revision: fc.integer({ min: 1, max: 20 }),
    summary: fc.string({ maxLength: 400 }),
    at: fc.constant(at),
  }),
  fc.record({
    type: fc.constant('capability_gap' as const),
    item: fc.string({ minLength: 1, maxLength: 40 }),
    reason: fc.constantFrom(
      'suppressed_by_flag' as const,
      'no_browser' as const,
      'no_interaction_tools' as const,
    ),
    summary: text,
    at: fc.constant(at),
  }),
);

describe('@no-llm agent progress mappers', () => {
  it('round-trip deep-equal and byte-equal for arbitrary agent events', () => {
    fc.assert(
      fc.property(agentEventArb, (event) => {
        const back = toAgentProgressEvent(toRunEvent(event));
        expect(back).toEqual(event);
        expect(JSON.stringify(back)).toBe(JSON.stringify(event));
      }),
      { numRuns: 500 },
    );
  });

  it('map every arbitrary agent event to a schema-valid RunEvent with `kind` first', () => {
    fc.assert(
      fc.property(agentEventArb, (event) => {
        expect(AgentProgressEvent.safeParse(event).success).toBe(true);
        const mapped = toRunEvent(event);
        expect(Object.keys(mapped)[0]).toBe('kind');
        expect(RunEvent.safeParse(mapped).success).toBe(true);
        expect(isAgentProgressRunEvent(mapped)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('return null for every non-agent kind', () => {
    const agentKinds = new Set<string>(AGENT_PROGRESS_KINDS);
    for (const kind of RUN_EVENT_KINDS.filter((k) => !agentKinds.has(k))) {
      const event = RunEvent.parse(fixture(kind).event) as RunEventType;
      expect(toAgentProgressEvent(event)).toBeNull();
      expect(isAgentProgressRunEvent(event)).toBe(false);
    }
  });
});
