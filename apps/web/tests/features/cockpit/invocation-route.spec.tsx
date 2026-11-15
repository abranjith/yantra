import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { InvocationSummary } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { RpcCallError } from '../../../src/host/rpc-client.js';
import { expectNoAxeViolations } from '../../support/axe.js';
import { FakeRpc, renderAt } from '../../support/fake-rpc.js';
import { ev, numbered } from '../../support/run-events.js';

const ID = '01JD2X7Q8R9S0T1V2W3X000007';

function summary(overrides: Partial<InvocationSummary> = {}): InvocationSummary {
  return {
    invocation_id: ID,
    state: 'queued',
    execution_class: 'run',
    path: ['research'],
    position: 1,
    run_id: null,
    queued_at: '2026-11-14T10:00:00.000Z',
    review: null,
    result: null,
    ...overrides,
  };
}

/** A host whose invocation record the test moves along. */
function fakeHost(initial: InvocationSummary): {
  rpc: FakeRpc;
  set: (next: InvocationSummary) => void;
} {
  let current = initial;
  const rpc = new FakeRpc()
    .answer('read.invocation', () => current)
    .answer('command.cancel', () => ({ ...current, state: 'discarded' }))
    .answer('queue.start', () => ({ ...current, state: 'spawning' }))
    .answer('queue.discard', () => ({ ...current, state: 'discarded' }))
    .answer('queue.resolve_review', () => ({}))
    .answer('run.subscribe', (params) => {
      for (const { seq, event } of numbered([ev('goal_echo'), ev('search_completed')])) {
        rpc.notify('run.event', { run_id: params.run_id, seq, event });
      }
      return { channel: 'live' };
    })
    .answer('run.unsubscribe', {});
  return {
    rpc,
    set: (next) => {
      current = next;
      act(() => {
        rpc.notify('invocation.changed', { ...next });
      });
    },
  };
}

function banner(): HTMLElement {
  return screen.getByRole('region', { name: /^Run status:/u });
}

describe('@no-llm invocation route', () => {
  it('shows queued with its position while two runs are already running', async () => {
    const host = fakeHost(summary());

    await renderAt(`/mission/invocations/${ID}`, host.rpc);

    await waitFor(() => {
      expect(banner().getAttribute('aria-label')).toBe('Run status: queued');
    });
    expect(within(banner()).getByText(/number 1 in line/u)).toBeDefined();
    expect(host.rpc.paramsOf('read.invocation')).toEqual([{ invocation_id: ID }]);
  });

  it('moves up the queue when another item changes', async () => {
    const host = fakeHost(summary({ position: 2 }));
    await renderAt(`/mission/invocations/${ID}`, host.rpc);
    await waitFor(() => {
      expect(within(banner()).getByText(/number 2 in line/u)).toBeDefined();
    });

    host.set(summary({ position: 1 }));

    await waitFor(() => {
      expect(within(banner()).getByText(/number 1 in line/u)).toBeDefined();
    });
  });

  it('cancels a queued item with command.cancel', async () => {
    const host = fakeHost(summary());
    await renderAt(`/mission/invocations/${ID}`, host.rpc);

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(host.rpc.paramsOf('command.cancel')).toEqual([{ invocation_id: ID }]);
  });

  it('replaces itself with the run cockpit once a run ID exists', async () => {
    const host = fakeHost(summary());
    const { router } = await renderAt(`/mission/invocations/${ID}`, host.rpc);
    await screen.findByRole('button', { name: 'Cancel' });

    host.set(summary({ state: 'spawning', run_id: 'run-9', position: undefined }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/mission/runs/run-9');
    });
    expect(router.state.location.search).toEqual({ invocation: ID, mode: 'research' });
    expect(router.history.length).toBe(1);
    await waitFor(() => {
      expect(screen.getByText('find flights')).toBeDefined();
    });
  });

  it('offers the review choices for needs_review', async () => {
    const host = fakeHost(
      summary({
        state: 'needs_review',
        position: undefined,
        review: {
          detected_at: '2026-11-14T10:00:00.000Z',
          differences: [
            { key: 'searchProvider', submitted: 'auto', current: 'brave', pinnable: true },
          ],
        },
      }),
    );
    await renderAt(`/mission/invocations/${ID}`, host.rpc);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Start with current settings' }),
    );

    expect(host.rpc.paramsOf('queue.resolve_review')).toEqual([
      { invocation_id: ID, choice: 'current' },
    ]);
    expect(
      screen.getByRole('button', { name: 'Start with the settings shown when queued' }),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDefined();
  });

  it('asks before starting an item whose start is unknown, focusing Cancel first', async () => {
    const host = fakeHost(summary({ state: 'start_unknown', position: undefined }));
    await renderAt(`/mission/invocations/${ID}`, host.rpc);

    await userEvent.click(await screen.findByRole('button', { name: 'Start anyway' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Start this run again?' });
    expect(document.activeElement?.textContent).toBe('Cancel');
    expect(host.rpc.paramsOf('queue.start')).toEqual([]);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Start anyway' }));

    expect(host.rpc.paramsOf('queue.start')).toEqual([
      { invocation_id: ID, acknowledge_duplicate_risk: true },
    ]);
  });

  it('shows a refused action inline with the host message', async () => {
    const host = fakeHost(summary());
    host.rpc.answer('command.cancel', () => {
      throw new RpcCallError(
        'command.cancel',
        -32003,
        'This item is running; stop it instead.',
        'not_allowed',
        undefined,
      );
    });
    await renderAt(`/mission/invocations/${ID}`, host.rpc);

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'This item is running; stop it instead.',
    );
  });

  it('says when there is no such item', async () => {
    const rpc = new FakeRpc().answer('read.invocation', () => {
      throw new RpcCallError(
        'read.invocation',
        -32004,
        'There is no queued item x.',
        'not_found',
        undefined,
      );
    });

    await renderAt(`/mission/invocations/${ID}`, rpc);

    expect(await screen.findByRole('heading', { name: 'Nothing to follow' })).toBeDefined();
  });

  it('has no axe violations while queued', async () => {
    const host = fakeHost(summary());
    const { container } = await renderAt(`/mission/invocations/${ID}`, host.rpc);
    await screen.findByRole('button', { name: 'Cancel' });

    await expectNoAxeViolations(container);
  });
});
