// @no-llm
/**
 * The `--json` read schemas the app renders (FEAT-066): `list` items, the
 * Ledger query and page, and the versioned cursor.
 */

import { describe, expect, it } from 'vitest';

import {
  CLI_READ_SCHEMA_VERSION,
  COMMAND_REGISTRY,
  LEDGER_DEFAULT_LIMIT,
  LedgerActiveRun,
  LedgerCursor,
  ListResult,
  ListRunItem,
  ReadListParams,
  RunLedgerPage,
  RunLedgerQuery,
  SCHEMA_VERSION,
  findLeaf,
} from '../src/index.js';

const RUN = {
  kind: 'run',
  runId: '20261101T000000Z-fixture-a7b3',
  workflowName: 'fixture',
  status: 'completed',
  startedAt: '2026-11-01T00:00:00.000Z',
  durationMs: 1000,
} as const;

describe('ListRunItem', () => {
  it('accepts the pre-FEAT-066 item unchanged', () => {
    expect(ListRunItem.parse(RUN)).toEqual(RUN);
  });

  it('accepts every additive field', () => {
    const item = {
      ...RUN,
      taskOutcome: 'fulfilled',
      executionState: 'interrupted',
      taskType: 'research',
      costUsd: null,
      hasDocument: true,
    };
    expect(ListRunItem.parse(item)).toEqual(item);
  });

  it.each([
    ['an unknown outcome word', { taskOutcome: 'maybe' }],
    ['an unknown mode', { taskType: 'browse' }],
    ['an unknown key', { extra: 1 }],
    ['a missing status', { status: undefined }],
  ])('rejects %s', (_label, change) => {
    expect(ListRunItem.safeParse({ ...RUN, ...change }).success).toBe(false);
  });
});

describe('ListResult', () => {
  it('uses the CLI envelope version, which equals the protocol schema version', () => {
    expect(CLI_READ_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
    const workflow = {
      kind: 'workflow',
      name: 'fixture',
      stepCount: 3,
      securityClass: 'public',
      modifiedAt: '2026-11-01T00:00:00.000Z',
    };
    expect(
      ListResult.parse({ schemaVersion: SCHEMA_VERSION, kind: 'list', items: [RUN, workflow] })
        .items,
    ).toHaveLength(2);
  });

  it('is the schema the list registry entry names', () => {
    expect(findLeaf(['list'])!.json.schema).toBe('ListResult');
    expect(COMMAND_REGISTRY.commands.some((entry) => entry.id === 'list')).toBe(true);
  });
});

describe('RunLedgerQuery', () => {
  it('defaults the target to runs and the limit to 50', () => {
    expect(RunLedgerQuery.parse({})).toEqual({ target: 'runs', limit: LEDGER_DEFAULT_LIMIT });
  });

  it('accepts every filter', () => {
    const query = {
      target: 'runs',
      cursor: 'abc',
      limit: 200,
      outcome: ['failed', 'unknown'],
      mode: ['ask', 'run'],
      since: '2026-11-01T00:00:00.000Z',
      until: '2026-11-02T00:00:00+05:30',
      text: '100% off',
      workflow: 'bank-statement',
      status: 'completed',
    };
    expect(RunLedgerQuery.parse(query)).toEqual(query);
  });

  it.each([
    ['limit 0', { limit: 0 }],
    ['limit 201', { limit: 201 }],
    ['a fractional limit', { limit: 1.5 }],
    ['empty text', { text: '' }],
    ['text over 200 characters', { text: 'x'.repeat(201) }],
    ['an unknown outcome', { outcome: ['great'] }],
    ['an empty outcome list', { outcome: [] }],
    ['an unknown mode', { mode: ['browse'] }],
    ['a non-ISO since', { since: 'yesterday' }],
    ['an unknown key', { page: 2 }],
    ['an over-long cursor', { cursor: 'x'.repeat(513) }],
  ])('rejects %s', (_label, params) => {
    expect(RunLedgerQuery.safeParse(params).success).toBe(false);
  });
});

describe('ReadListParams', () => {
  it('routes workflows to the workflow query and anything else to the ledger', () => {
    expect(ReadListParams.parse({ target: 'workflows' })).toEqual({ target: 'workflows' });
    expect(ReadListParams.parse({ limit: 5 })).toEqual({ target: 'runs', limit: 5 });
    expect(ReadListParams.safeParse({ target: 'workflows', limit: 5 }).success).toBe(false);
    expect(ReadListParams.safeParse({ target: 'schedules' }).success).toBe(false);
  });
});

describe('RunLedgerPage', () => {
  it('carries the list envelope, cursor, source and the active region', () => {
    const page = {
      schemaVersion: SCHEMA_VERSION,
      kind: 'list',
      items: [RUN],
      next_cursor: null,
      source: 'files',
      scan_truncated: true,
      active: [{ ...RUN, status: 'running', displayedState: 'waiting_for_you' }],
    };
    expect(RunLedgerPage.parse(page)).toEqual(page);
  });

  it('rejects an active run without a displayed state', () => {
    expect(LedgerActiveRun.safeParse({ ...RUN }).success).toBe(false);
    expect(LedgerActiveRun.safeParse({ ...RUN, displayedState: 'dead' }).success).toBe(false);
  });
});

describe('LedgerCursor', () => {
  it('accepts version 1 only', () => {
    const cursor = {
      v: 1,
      started_at: '2026-11-01T00:00:00.000Z',
      run_id: 'r',
      source: 'index',
    };
    expect(LedgerCursor.parse(cursor)).toEqual(cursor);
    expect(LedgerCursor.safeParse({ ...cursor, v: 2 }).success).toBe(false);
    expect(LedgerCursor.safeParse({ ...cursor, source: 'web' }).success).toBe(false);
  });
});
