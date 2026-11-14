import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FakeRpc, renderAt } from '../../support/fake-rpc.js';
import { ev, numbered } from '../../support/run-events.js';

describe('@no-llm cockpit live region', () => {
  it('has one polite atomic region that speaks without moving focus', async () => {
    const rpc = new FakeRpc()
      .answer('run.subscribe', (params) => {
        for (const { seq, event } of numbered([ev('goal_echo'), ev('assistant_text')])) {
          rpc.notify('run.event', { run_id: params.run_id, seq, event });
        }
        return { channel: 'live' };
      })
      .answer('run.unsubscribe', {});
    const { container } = await renderAt('/mission/runs/run-1?mode=do', rpc);
    const trigger = await screen.findByRole('button', { name: /Other events/u });
    trigger.focus();

    act(() => {
      numbered(
        [
          ev('contract_declared'),
          ...Array.from({ length: 100 }, (_, index) =>
            index % 2 === 0 ? ev('tool_started') : ev('tool_finished'),
          ),
          ev('progress'),
        ],
        3,
      ).forEach(({ seq, event }) => {
        rpc.notify('run.event', { run_id: 'run-1', seq, event });
      });
    });

    const regions = container.querySelectorAll('[data-part="cockpit"] [aria-live]');
    expect(regions).toHaveLength(1);
    expect(regions[0]?.getAttribute('aria-live')).toBe('polite');
    expect(regions[0]?.getAttribute('aria-atomic')).toBe('true');
    // The first state was spoken at once; the next waits out the 2 s window.
    await waitFor(
      () => {
        expect(regions[0]?.textContent).toContain('Run status: running.');
      },
      { timeout: 4_000 },
    );
    expect(document.activeElement).toBe(trigger);
  });
});
