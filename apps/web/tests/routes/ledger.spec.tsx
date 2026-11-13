// @no-llm
/**
 * The Ledger route (FEAT-066 TASK-003): paging on scroll, filters in the URL,
 * live updates announced politely, fallback notes, a bounded DOM, and axe.
 * The host connection is faked at the RPC boundary; everything above is real.
 */

import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ListRunItem, RunLedgerPage } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  filtersFromSearch,
  parseLedgerSearch,
  searchFromFilters,
} from '../../src/routes/ledger.js';
import { expectNoAxeViolations } from '../support/axe.js';
import { FakeRpc, renderAt } from '../support/fake-rpc.js';
import {
  installIntersectionObserver,
  resetIntersectionObservers,
  setIntersecting,
} from '../support/intersection-observer.js';
import { useFixedLayout } from '../support/layout.js';

useFixedLayout(1200, 600);

beforeEach(() => {
  installIntersectionObserver();
});

afterEach(() => {
  resetIntersectionObservers();
});

function run(index: number, overrides: Partial<ListRunItem> = {}): ListRunItem {
  const startedAt = new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString();
  return {
    kind: 'run',
    runId: `20261101T0000${String(index).padStart(2, '0')}Z-run-${String(index).padStart(5, '0')}`,
    workflowName: `Goal ${String(index)}`,
    status: 'completed',
    startedAt,
    durationMs: 1500,
    taskOutcome: 'fulfilled',
    taskType: 'research',
    costUsd: 0.12,
    hasDocument: true,
    ...overrides,
  };
}

function page(items: ListRunItem[], overrides: Partial<RunLedgerPage> = {}): RunLedgerPage {
  return {
    schemaVersion: '0.2',
    kind: 'list',
    items,
    next_cursor: null,
    source: 'index',
    active: [],
    ...overrides,
  };
}

function rowHeaders(): string[] {
  const table = screen.getByRole('grid', { name: 'History' });
  return within(table)
    .getAllByRole('rowheader')
    .map((cell) => cell.textContent ?? '');
}

describe('the Ledger', () => {
  it('lists runs with the CLI outcome words and a run link per row', async () => {
    const rpc = new FakeRpc().answer(
      'read.list',
      page([run(2), run(1, { taskOutcome: 'failed', status: 'failed' })]),
    );

    await renderAt('/runs', rpc);

    await waitFor(() => {
      expect(rowHeaders()).toEqual(['Goal 2', 'Goal 1']);
    });
    expect(screen.getByText('completed fulfilled')).toBeTruthy();
    expect(screen.getByText('failed failed')).toBeTruthy();
    expect(screen.getAllByText('$0.12')).toHaveLength(2);
    expect(rpc.paramsOf('read.list')[0]).toEqual({ target: 'runs', limit: 50 });
  });

  it('opens a run when its row is activated', async () => {
    const rpc = new FakeRpc().answer('read.list', page([run(2)]));
    const { router } = await renderAt('/runs', rpc);
    await waitFor(() => {
      expect(rowHeaders()).toEqual(['Goal 2']);
    });

    await userEvent.click(screen.getByText('Goal 2'));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/runs/${run(2).runId}`);
    });
  });

  it('requests the next cursor once when the end of the list scrolls into view', async () => {
    const rpc = new FakeRpc().answer('read.list', (params) =>
      params.cursor === undefined
        ? page([run(9), run(8)], { next_cursor: 'c-1' })
        : page([run(7)], { next_cursor: null }),
    );
    await renderAt('/runs', rpc);
    await waitFor(() => {
      expect(rowHeaders()).toHaveLength(2);
    });

    act(() => {
      setIntersecting(true);
    });
    act(() => {
      setIntersecting(true);
    });

    await waitFor(() => {
      expect(rowHeaders()).toEqual(['Goal 9', 'Goal 8', 'Goal 7']);
    });
    const cursors = rpc.paramsOf('read.list').map((params) => params.cursor);
    expect(cursors.filter((cursor) => cursor === 'c-1')).toHaveLength(1);
  });

  it('reads filters from the URL and sends them to read.list', async () => {
    const rpc = new FakeRpc().answer('read.list', page([]));

    await renderAt('/runs?outcome=failed,unknown&mode=ask&q=bank', rpc);

    await waitFor(() => {
      expect(rpc.paramsOf('read.list')).toHaveLength(1);
    });
    expect(rpc.paramsOf('read.list')[0]).toEqual({
      target: 'runs',
      limit: 50,
      outcome: ['failed', 'unknown'],
      mode: ['ask'],
      text: 'bank',
    });
    expect(screen.getByRole('checkbox', { name: 'failed' }).checked).toBe(true);
    expect(screen.getByRole('searchbox', { name: 'Search' }).value).toBe('bank');
    expect(screen.getByText('No runs match these filters.')).toBeTruthy();
  });

  it('writes filter changes to the URL after the debounce, so a reload keeps them', async () => {
    const rpc = new FakeRpc().answer('read.list', page([run(1)]));
    const { router } = await renderAt('/runs', rpc);

    await userEvent.click(screen.getByRole('checkbox', { name: 'failed' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'bank');

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ outcome: 'failed', q: 'bank' });
    });
    await waitFor(() => {
      expect(rpc.paramsOf('read.list').at(-1)).toMatchObject({
        outcome: ['failed'],
        text: 'bank',
      });
    });
    // Debounced: typing four letters did not issue four filtered requests.
    expect(
      rpc.paramsOf('read.list').filter((params) => params.text !== undefined).length,
    ).toBeLessThanOrEqual(2);
  });

  it('refetches page one on a runs.changed hint and announces new runs without moving focus', async () => {
    // Arrange
    let pageOne = page([run(2), run(1)]);
    const rpc = new FakeRpc().answer('read.list', () => pageOne);
    await renderAt('/runs', rpc);
    await waitFor(() => {
      expect(rowHeaders()).toEqual(['Goal 2', 'Goal 1']);
    });
    const search = screen.getByRole('searchbox', { name: 'Search' });
    search.focus();
    expect(rpc.subscriptions).toContain('runs.subscribe');

    // Act: two runs arrive.
    pageOne = page([run(4), run(3), run(2), run(1)]);
    act(() => {
      rpc.notify('runs.changed', { run_ids: [], live_run_ids: [] });
    });

    // Assert
    await waitFor(() => {
      expect(rowHeaders()).toEqual(['Goal 4', 'Goal 3', 'Goal 2', 'Goal 1']);
    });
    const live = screen.getAllByRole('status').find((node) => node.textContent === '2 new runs');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(document.activeElement).toBe(search);
  });

  it('shows active runs with their displayed state above History', async () => {
    const rpc = new FakeRpc().answer(
      'read.list',
      page([run(1)], {
        active: [
          {
            ...run(5, { status: 'running', taskOutcome: undefined }),
            displayedState: 'waiting_for_you',
          },
        ],
      }),
    );

    await renderAt('/runs', rpc);

    const active = await screen.findByRole('region', { name: 'Active' });
    expect(within(active).getByText('waiting for you')).toBeTruthy();
    expect(within(active).getByRole('link', { name: 'Goal 5' }).getAttribute('href')).toBe(
      `/runs/${run(5).runId}`,
    );
  });

  it('says when it is showing runs from files and when the scan stopped early', async () => {
    const rpc = new FakeRpc().answer(
      'read.list',
      page([run(1)], { source: 'files', scan_truncated: true }),
    );

    await renderAt('/runs', rpc);

    expect(
      await screen.findByText(/History index unavailable — showing runs from files only/u),
    ).toBeTruthy();
    expect(
      screen.getByText('Showing the newest runs; refine filters to search further.'),
    ).toBeTruthy();
  });

  it('says so when there are no runs at all', async () => {
    const rpc = new FakeRpc().answer('read.list', page([]));
    await renderAt('/runs', rpc);
    expect(await screen.findByText('No runs yet.')).toBeTruthy();
    expect(screen.getByText('No runs in progress.')).toBeTruthy();
  });

  it('keeps the DOM bounded for 10,000 runs', async () => {
    const many = Array.from({ length: 10_000 }, (_, index) =>
      run(index % 60, { runId: `r-${String(index)}`, workflowName: `Goal ${String(index)}` }),
    );
    const rpc = new FakeRpc().answer('read.list', page(many));

    await renderAt('/runs', rpc);

    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    expect(screen.getAllByRole('row').length).toBeLessThanOrEqual(100);
  }, 30_000);

  it('has no axe violations in light and dark', async () => {
    const rpc = new FakeRpc().answer(
      'read.list',
      page([run(2), run(1)], {
        active: [{ ...run(5, { status: 'running' }), displayedState: 'running' }],
      }),
    );
    const { container } = await renderAt('/runs', rpc);
    await waitFor(() => {
      expect(rowHeaders()).toHaveLength(2);
    });

    await expectNoAxeViolations(container);
  });
});

describe('search params', () => {
  it('keeps only well-formed values', () => {
    expect(
      parseLedgerSearch({
        outcome: 'failed,bogus,partial',
        mode: 'browse',
        since: '2026-11-01',
        until: 'tomorrow',
        q: '',
        extra: 'x',
      }),
    ).toEqual({ outcome: 'failed,partial', since: '2026-11-01' });
  });

  it('round-trips filters', () => {
    const search = {
      outcome: 'handoff,unknown',
      mode: 'do',
      since: '2026-11-01',
      until: '2026-11-02',
      q: 'bank',
    };
    expect(searchFromFilters(filtersFromSearch(search))).toEqual(search);
  });

  it('caps the text at 200 characters', () => {
    expect(parseLedgerSearch({ q: 'x'.repeat(250) }).q).toHaveLength(200);
  });
});
