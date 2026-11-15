import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { routesFor } from '../../../src/features/live/event-routes.js';
import { expectNoAxeViolations } from '../../support/axe.js';
import { FakeRpc, renderAt } from '../../support/fake-rpc.js';
import { recordedResearch, relayRecords } from '../../support/recorded-runs.js';

describe('@no-llm cockpit route', () => {
  it('shows every recorded research --no-llm event in the timeline or the inspector', async () => {
    const { runId, records } = recordedResearch();
    const rpc = relayRecords(new FakeRpc(), records);

    const { container } = await renderAt(`/mission/runs/${runId}`, rpc);

    const timeline = records.filter((record) => routesFor(record.event.kind).includes('timeline'));
    const inspected = records.filter((record) =>
      routesFor(record.event.kind).includes('inspector'),
    );
    await waitFor(() => {
      expect(container.querySelectorAll('[data-instrument="timeline"] [data-seq]')).toHaveLength(
        timeline.length,
      );
    });
    const shownSeqs = [
      ...container.querySelectorAll<HTMLElement>('[data-instrument="timeline"] [data-seq]'),
    ].map((row) => Number(row.dataset.seq));
    expect(shownSeqs).toEqual(timeline.map((record) => record.seq));
    expect(
      within(container.querySelector('[data-instrument="inspector"]')!).getByText(
        `Other events (${String(inspected.length)})`,
      ),
    ).toBeDefined();
    expect(rpc.paramsOf('run.subscribe')).toEqual([{ run_id: runId, from_seq: 1 }]);
  });

  it('lays out the four panels over the backdrop slot', async () => {
    const { runId, records } = recordedResearch();

    const { container } = await renderAt(
      `/mission/runs/${runId}`,
      relayRecords(new FakeRpc(), records),
    );

    expect(container.querySelector('[data-slot="backdrop"]')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-panel]')].map(
        (panel) => panel.dataset.panel,
      ),
    ).toEqual(['top-bar', 'understood', 'engine', 'command']);
    expect(screen.getByRole('heading', { name: 'Engine' })).toBeDefined();
  });

  it('has no axe violations with a replayed run', async () => {
    const { runId, records } = recordedResearch();
    const { container } = await renderAt(
      `/mission/runs/${runId}`,
      relayRecords(new FakeRpc(), records),
    );
    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-instrument="timeline"] [data-seq]').length,
      ).toBeGreaterThan(0);
    });

    await expectNoAxeViolations(container);
  });
});
