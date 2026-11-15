import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UnderstoodPanel } from '../../../src/features/cockpit/UnderstoodPanel.js';
import {
  initialCockpitState,
  reduceRunEvents,
  type CockpitMode,
  type CockpitState,
} from '../../../src/features/live/cockpit-state.js';
import { FakeRpc, renderAt } from '../../support/fake-rpc.js';
import { ev, numbered } from '../../support/run-events.js';

function stateOf(events: readonly unknown[], mode: CockpitMode = 'do'): CockpitState {
  return reduceRunEvents(initialCockpitState('run-1', mode), numbered(events)).state;
}

/** A scripted fake-provider `do` run: contract, then progress. */
const SCRIPTED_DO = [
  ev('goal_echo', { display: 'goal: "fill the contact form"' }),
  ev('contract_declared'),
  ev('tool_started'),
  ev('progress', {
    items: [
      { id: 'fill', kind: 'fill', label: 'Fill the form', state: 'advancing', done: 1, total: 3 },
      {
        id: 'deliverable',
        kind: 'deliverable',
        label: 'Report',
        state: 'pending',
        done: null,
        total: null,
      },
    ],
  }),
  ev('tool_finished'),
  ev('progress', {
    items: [
      { id: 'fill', kind: 'fill', label: 'Fill the form', state: 'met', done: 3, total: 3 },
      {
        id: 'deliverable',
        kind: 'deliverable',
        label: 'Report',
        state: 'met',
        done: null,
        total: null,
      },
    ],
  }),
];

describe('@no-llm Understood panel', () => {
  it('shows the contract summary in the agent voice with its revision', () => {
    const { rerender } = render(<UnderstoodPanel state={stateOf([ev('contract_declared')])} />);
    expect(screen.getByText('Revision 1')).toBeDefined();
    expect(screen.getByText('Fill the contact form and take a screenshot').className).toContain(
      'type-agent',
    );

    rerender(
      <UnderstoodPanel
        state={stateOf([
          ev('contract_declared'),
          ev('contract_declared', { revision: 2, summary: 'Fill the contact form only' }),
        ])}
      />,
    );
    expect(screen.getByText('Revision 2')).toBeDefined();
    expect(screen.getByText('Fill the contact form only')).toBeDefined();
    expect(screen.queryByText('Revision 1')).toBeNull();
  });

  it('lists capability gaps as notices beneath the contract', () => {
    render(<UnderstoodPanel state={stateOf([ev('contract_declared'), ev('capability_gap')])} />);

    expect(screen.getByRole('note').textContent).toBe('Cannot deliver: viewport screenshot.');
  });

  it('shows the ring and the live requirements from progress', () => {
    render(<UnderstoodPanel state={stateOf([ev('contract_declared'), ev('progress')])} />);

    expect(screen.getByRole('img', { name: '0 of 2 requirements met' })).toBeDefined();
    expect(screen.getByText('2 of 5')).toBeDefined();
  });

  it('shows phases and source counts for a deterministic run, never an empty ring', () => {
    const { container } = render(
      <UnderstoodPanel
        state={stateOf(
          [
            ev('search_completed'),
            ev('source_fetched'),
            ev('source_fetched', { status: 'failed', failure_class: 'fetch' }),
            ev('extract_completed', { extracted: 1, failed: 1 }),
          ],
          'research',
        )}
      />,
    );

    expect(container.querySelector('[data-part="phases"]')?.textContent).toContain('extracting');
    expect(container.querySelector('[data-instrument="contract-ring"]')).toBeNull();
    const values = [...container.querySelectorAll('dd')].map((node) => node.textContent);
    expect(values).toEqual(['1', '1', '1', '1']);
  });

  it('shows the phase view for ask before its first phase', () => {
    const { container } = render(<UnderstoodPanel state={stateOf([ev('goal_echo')], 'ask')} />);

    expect(container.querySelector('[data-part="phases"]')?.textContent).toContain('—');
  });

  it('says it is waiting before an agentic run declares anything', () => {
    render(<UnderstoodPanel state={stateOf([ev('goal_echo')])} />);

    expect(screen.getByText('Waiting for the run to say what it will do.')).toBeDefined();
  });

  it('fills the ring segments from a scripted do run in the cockpit route', async () => {
    const rpc = new FakeRpc()
      .answer('run.subscribe', (params) => {
        for (const { seq, event } of numbered(SCRIPTED_DO)) {
          rpc.notify('run.event', { run_id: params.run_id, seq, event });
        }
        return { channel: 'replay_only' };
      })
      .answer('run.unsubscribe', {});

    const { container } = await renderAt('/mission/runs/run-do?mode=do', rpc);

    await waitFor(() => {
      expect(screen.getByRole('img', { name: '2 of 2 requirements met' })).toBeDefined();
    });
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-segment]')].map(
        (segment) => segment.dataset.state,
      ),
    ).toEqual(['met', 'met']);
    expect(container.querySelector('[data-part="mode"]')?.textContent).toBe('do');
  });
});
