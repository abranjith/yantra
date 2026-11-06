import { act, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixtureRuns, type FixtureRun } from '../../src/gallery/fixtures.js';
import {
  Table,
  TableContractError,
  type TableColumn,
  type TableLoadState,
} from '../../src/primitives/Table.js';
import {
  installIntersectionObserver,
  observedCount,
  resetIntersectionObservers,
  setIntersecting,
} from '../support/intersection-observer.js';
import { useFixedLayout } from '../support/layout.js';

const COLUMNS: readonly TableColumn<FixtureRun>[] = [
  { id: 'id', header: 'Run', cell: (run) => run.id, voice: 'engine' },
  { id: 'goal', header: 'Goal', cell: (run) => run.goal, isRowHeader: true },
  { id: 'duration', header: 'Duration', cell: (run) => run.duration, align: 'end' },
];

// jsdom has no layout; React Aria's virtualizer tests size elements the same way.
useFixedLayout();

beforeEach(() => {
  installIntersectionObserver();
});

afterEach(() => {
  resetIntersectionObservers();
});

function RunsTable({
  rows,
  loadState,
  onLoadMore,
  onRowAction,
}: {
  readonly rows: readonly FixtureRun[];
  readonly loadState?: TableLoadState;
  readonly onLoadMore?: () => void;
  readonly onRowAction?: (key: string) => void;
}) {
  return (
    <Table
      aria-label="Runs"
      columns={COLUMNS}
      rows={rows}
      getRowKey={(run) => run.id}
      emptyState="No runs yet"
      {...(loadState === undefined ? {} : { loadState })}
      {...(onLoadMore === undefined ? {} : { onLoadMore })}
      {...(onRowAction === undefined ? {} : { onRowAction })}
    />
  );
}

function bodyRows(): HTMLElement[] {
  const grid = screen.getByRole('grid', { name: 'Runs' });
  return within(grid)
    .getAllByRole('row')
    .filter((row) => within(row).queryAllByRole('columnheader').length === 0);
}

describe('@no-llm Drshya Table', () => {
  it('renders 10,000 rows with a bounded DOM', () => {
    render(<RunsTable rows={fixtureRuns(10_000)} />);

    const rows = screen.getAllByRole('row');
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.length).toBeLessThanOrEqual(60);
    expect(screen.getByRole('grid', { name: 'Runs' }).getAttribute('aria-rowcount')).toBe('10001');
  });

  it('renders column headers and exactly one row header per row', () => {
    render(<RunsTable rows={fixtureRuns(5)} />);

    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Run',
      'Goal',
      'Duration',
    ]);
    for (const row of bodyRows()) {
      expect(within(row).getAllByRole('rowheader')).toHaveLength(1);
    }
    expect(within(bodyRows()[0] ?? document.body).getByRole('rowheader').textContent).toBe(
      fixtureRuns(1)[0]?.goal,
    );
  });

  it('sets engine-voice cells in the mono voice', () => {
    render(<RunsTable rows={fixtureRuns(1)} />);

    const cell = within(bodyRows()[0] ?? document.body).getByText('run-00001');
    expect(cell.closest('[role="gridcell"]')?.className).toContain('type-engine');
  });

  it('moves focus between rows and cells with the arrow keys', async () => {
    render(<RunsTable rows={fixtureRuns(5)} />);

    await userEvent.tab();
    const first = document.activeElement;
    expect(first?.getAttribute('role')).toBe('row');

    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).not.toBe(first);
    expect(document.activeElement?.getAttribute('role')).toBe('row');

    await userEvent.keyboard('{ArrowRight}');
    expect(['gridcell', 'rowheader']).toContain(document.activeElement?.getAttribute('role'));
  });

  it('reports row actions with the row key', async () => {
    const onRowAction = vi.fn();
    render(<RunsTable rows={fixtureRuns(3)} onRowAction={onRowAction} />);

    await userEvent.tab();
    await userEvent.keyboard('{Enter}');

    expect(onRowAction).toHaveBeenCalledWith('run-00001');
  });

  describe('paging', () => {
    it('asks for more once when the sentinel is visible and the table is idle', () => {
      const onLoadMore = vi.fn();
      render(<RunsTable rows={fixtureRuns(20)} loadState="idle" onLoadMore={onLoadMore} />);

      expect(observedCount()).toBeGreaterThan(0);
      act(() => {
        setIntersecting(true);
      });

      expect(onLoadMore).toHaveBeenCalledTimes(1);
    });

    it('does not ask while the sentinel is out of view', () => {
      const onLoadMore = vi.fn();
      render(<RunsTable rows={fixtureRuns(20)} loadState="idle" onLoadMore={onLoadMore} />);

      act(() => {
        setIntersecting(false);
      });

      expect(onLoadMore).not.toHaveBeenCalled();
    });

    it.each<TableLoadState>(['loading', 'exhausted', 'error'])(
      'does not ask while %s',
      (loadState) => {
        const onLoadMore = vi.fn();
        render(<RunsTable rows={fixtureRuns(20)} loadState={loadState} onLoadMore={onLoadMore} />);

        act(() => {
          setIntersecting(true);
        });

        expect(onLoadMore).not.toHaveBeenCalled();
      },
    );

    it('asks again after the state returns to idle with new rows', () => {
      const onLoadMore = vi.fn();
      function Paged() {
        const [rows, setRows] = useState(() => fixtureRuns(20));
        const [state, setState] = useState<TableLoadState>('idle');
        return (
          <>
            <button
              type="button"
              onClick={() => {
                setRows(fixtureRuns(40));
                setState('idle');
              }}
            >
              page loaded
            </button>
            <RunsTable
              rows={rows}
              loadState={state}
              onLoadMore={() => {
                onLoadMore();
                setState('loading');
              }}
            />
          </>
        );
      }
      render(<Paged />);

      act(() => {
        setIntersecting(true);
      });
      expect(onLoadMore).toHaveBeenCalledTimes(1);

      act(() => {
        setIntersecting(true);
      });
      expect(onLoadMore).toHaveBeenCalledTimes(1);

      act(() => {
        screen.getByRole('button', { name: 'page loaded' }).click();
      });
      act(() => {
        setIntersecting(true);
      });
      expect(onLoadMore).toHaveBeenCalledTimes(2);
    });

    it('shows a loading row while a page is in flight', () => {
      render(<RunsTable rows={fixtureRuns(3)} loadState="loading" onLoadMore={() => undefined} />);

      expect(screen.getByRole('status').textContent).toBe('Loading more…');
    });

    it('shows an error row whose Retry calls onLoadMore', async () => {
      const onLoadMore = vi.fn();
      render(<RunsTable rows={fixtureRuns(3)} loadState="error" onLoadMore={onLoadMore} />);

      expect(screen.getByText('Couldn’t load more')).toBeDefined();
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(onLoadMore).toHaveBeenCalledTimes(1);
    });

    it('renders no sentinel once exhausted', () => {
      render(
        <RunsTable rows={fixtureRuns(3)} loadState="exhausted" onLoadMore={() => undefined} />,
      );

      expect(observedCount()).toBe(0);
      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  it('renders the empty state when there are no rows', () => {
    render(<RunsTable rows={[]} />);

    expect(screen.getByText('No runs yet')).toBeDefined();
  });

  it.each([
    ['no row header', COLUMNS.map((column) => ({ ...column, isRowHeader: false }))],
    ['two row headers', COLUMNS.map((column) => ({ ...column, isRowHeader: true }))],
  ])('throws a TableContractError with %s', (_label, columns) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() =>
      render(
        <Table
          aria-label="Runs"
          columns={columns}
          rows={fixtureRuns(1)}
          getRowKey={(run) => run.id}
          emptyState="none"
        />,
      ),
    ).toThrow(TableContractError);
  });

  it('requires an accessible name by type', () => {
    const element = (
      // @ts-expect-error a table needs aria-label or aria-labelledby
      <Table
        columns={COLUMNS}
        rows={[]}
        getRowKey={(run: FixtureRun) => run.id}
        emptyState="none"
      />
    );

    expect(element).toBeDefined();
  });
});
