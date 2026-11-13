// @no-llm
/**
 * The run data hooks' pure parts (FEAT-066 TASK-003): `read.list` params,
 * de-duplicated rows, and the first-page merge a change hint performs.
 */

import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ListRunItem, RunLedgerPage } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import {
  LEDGER_PAGE_SIZE,
  dayStart,
  ledgerKey,
  ledgerParams,
  ledgerRows,
  mergeFirstPage,
  refreshLedgerFirstPages,
} from '../../src/data/runs.js';
import { FakeRpc } from '../support/fake-rpc.js';

function run(id: string, second: number, overrides: Partial<ListRunItem> = {}): ListRunItem {
  return {
    kind: 'run',
    runId: id,
    workflowName: id,
    status: 'completed',
    startedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, second)).toISOString(),
    durationMs: 1,
    ...overrides,
  };
}

function page(items: ListRunItem[], next: string | null = null): RunLedgerPage {
  return {
    schemaVersion: '0.2',
    kind: 'list',
    items,
    next_cursor: next,
    source: 'index',
    active: [],
  };
}

describe('ledgerParams', () => {
  it('sends only the page size and target without filters', () => {
    expect(ledgerParams({}, undefined)).toEqual({ target: 'runs', limit: LEDGER_PAGE_SIZE });
  });

  it('sends the cursor and every filter', () => {
    const params = ledgerParams(
      { outcome: ['failed'], mode: 'do', since: '2026-11-01', until: '2026-11-03', text: 'x' },
      'c',
    );
    expect(params).toMatchObject({
      cursor: 'c',
      outcome: ['failed'],
      mode: ['do'],
      since: dayStart('2026-11-01'),
      until: dayStart('2026-11-04'),
      text: 'x',
    });
  });

  it('drops an empty outcome list and empty text', () => {
    expect(ledgerParams({ outcome: [], text: '' }, undefined)).toEqual({
      target: 'runs',
      limit: LEDGER_PAGE_SIZE,
    });
  });
});

describe('dayStart', () => {
  it('is local midnight as an ISO instant, the until bound being the next day', () => {
    expect(dayStart('2026-11-01')).toBe(new Date(2026, 10, 1).toISOString());
    expect(dayStart('2026-11-30', 1)).toBe(new Date(2026, 11, 1).toISOString());
  });

  it.each([undefined, '', 'tomorrow', '2026-1-1'])('is undefined for %j', (day) => {
    expect(dayStart(day)).toBeUndefined();
  });
});

describe('ledgerRows', () => {
  it('flattens pages in order, each run once', () => {
    const data: InfiniteData<RunLedgerPage> = {
      pages: [page([run('b', 2), run('a', 1)]), page([run('a', 1), run('z', 0)])],
      pageParams: [undefined, 'c'],
    };
    expect(ledgerRows(data).map((row) => row.runId)).toEqual(['b', 'a', 'z']);
    expect(ledgerRows(undefined)).toEqual([]);
  });
});

describe('mergeFirstPage', () => {
  it('adds new rows, refreshes changed ones, keeps loaded rows and the loaded cursor', () => {
    const loaded = page([run('c', 3), run('b', 2), run('a', 1)], 'cursor-after-a');
    const fresh = page(
      [run('e', 5), run('d', 4), run('c', 3, { status: 'failed' })],
      'cursor-after-c',
    );

    const merged = mergeFirstPage(fresh, loaded);

    expect(merged.items.map((row) => [row.runId, row.status])).toEqual([
      ['e', 'completed'],
      ['d', 'completed'],
      ['c', 'failed'],
      ['b', 'completed'],
      ['a', 'completed'],
    ]);
    expect(merged.next_cursor).toBe('cursor-after-a');
  });

  it('drops a row that is now active and takes the fresh active region', () => {
    const loaded = page([run('a', 1)]);
    const fresh: RunLedgerPage = {
      ...page([]),
      active: [{ ...run('a', 1, { status: 'running' }), displayedState: 'running' }],
    };
    const merged = mergeFirstPage(fresh, loaded);
    expect(merged.items).toEqual([]);
    expect(merged.active.map((row) => row.runId)).toEqual(['a']);
  });
});

describe('refreshLedgerFirstPages', () => {
  it('refreshes page one of each loaded Ledger with its own filters and counts new runs', async () => {
    // Arrange: two Ledgers loaded, one filtered.
    const client = new QueryClient();
    client.setQueryData(ledgerKey({}), {
      pages: [page([run('a', 1)], 'p2'), page([run('z', 0)])],
      pageParams: [undefined, 'p2'],
    });
    client.setQueryData(ledgerKey({ text: 'q' }), { pages: [page([])], pageParams: [undefined] });
    const rpc = new FakeRpc().answer('read.list', (params) =>
      params.text === 'q' ? page([]) : page([run('c', 3), run('b', 2), run('a', 1)]),
    );

    // Act
    const added = await refreshLedgerFirstPages(rpc, client);

    // Assert
    expect(added).toBe(2);
    expect(
      rpc
        .paramsOf('read.list')
        .map((params) => params.text ?? null)
        .sort(),
    ).toEqual([null, 'q']);
    const data = client.getQueryData<InfiniteData<RunLedgerPage>>(ledgerKey({}));
    expect(ledgerRows(data).map((row) => row.runId)).toEqual(['c', 'b', 'a', 'z']);
    expect(data?.pages[0]?.next_cursor).toBe('p2');
    expect(rpc.paramsOf('read.list').every((params) => params.cursor === undefined)).toBe(true);
  });

  it('skips Ledgers that have not loaded', async () => {
    const client = new QueryClient();
    const rpc = new FakeRpc().answer('read.list', page([]));
    expect(await refreshLedgerFirstPages(rpc, client)).toBe(0);
    expect(rpc.calls).toEqual([]);
  });
});
