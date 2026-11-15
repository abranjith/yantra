import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { parseInvocation, type InvocationSummary } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import {
  FORCE_STOP_TEXT,
  StopControl,
  stopIsGraceful,
} from '../../../src/features/cockpit/StopControl.js';
import { initialCockpitState, reduceRunEvents } from '../../../src/features/live/cockpit-state.js';
import { deriveDisplayedState } from '../../../src/features/live/displayed-state.js';
import { RpcCallError } from '../../../src/host/rpc-client.js';
import { FakeRpc, renderAt } from '../../support/fake-rpc.js';
import { ev, numbered } from '../../support/run-events.js';

const ID = '01JD2X7Q8R9S0T1V2W3X000011';
const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';

function requested(argv: readonly string[]) {
  const parsed = parseInvocation(argv, { cwd: CWD, invocationId: ID });
  if (!parsed.isOk) throw new Error(parsed.error.message);
  return parsed.value.invocation;
}

function summary(
  argv: readonly string[],
  overrides: Partial<InvocationSummary> = {},
): InvocationSummary {
  const invocation = requested(argv);
  return {
    invocation_id: ID,
    state: 'running',
    execution_class: 'run',
    path: [...invocation.path],
    invocation,
    run_id: 'run-1',
    queued_at: '2026-11-14T10:00:00.000Z',
    review: null,
    result: null,
    ...overrides,
  };
}

/** A host with a live run; the test pushes more events and counts cancels. */
function host(argv: readonly string[], events: readonly unknown[] = [ev('goal_echo')]) {
  const rpc = new FakeRpc()
    .answer('read.invocation', () => summary(argv))
    .answer('command.cancel', () => summary(argv))
    .answer('run.subscribe', (params) => {
      for (const { seq, event } of numbered(events)) {
        rpc.notify('run.event', { run_id: params.run_id, seq, event });
      }
      return { channel: 'live' };
    })
    .answer('run.unsubscribe', {});
  const push = (seq: number, event: unknown): void => {
    act(() => {
      rpc.notify('run.event', { run_id: 'run-1', seq, event });
    });
  };
  return { rpc, push };
}

async function cockpit(rpc: FakeRpc): Promise<HTMLElement> {
  await renderAt(`/mission/runs/run-1?invocation=${ID}`, rpc);
  return screen.findByRole('button', { name: /^Stop/u });
}

describe('@no-llm Stop wording', () => {
  it('reads Stop where the command honors abort, Stop (force) elsewhere', () => {
    expect(stopIsGraceful(requested(['do', 'fill the form']), null)).toBe(true);
    expect(stopIsGraceful(requested(['ask', 'q']), null)).toBe(true);
    expect(stopIsGraceful(requested(['research', 'q', '--no-llm']), null)).toBe(false);
    expect(stopIsGraceful(requested(['run', 'nightly']), null)).toBe(false);
    expect(stopIsGraceful(requested(['resume', 'run-0']), null)).toBe(false);
  });

  it('follows the host-resolved mode when no flag says it (LLM_PROVIDER=none)', () => {
    expect(stopIsGraceful(requested(['research', 'q']), null, 'deterministic')).toBe(false);
    expect(stopIsGraceful(requested(['research', 'q']), null, 'llm')).toBe(true);
    expect(stopIsGraceful(requested(['do', 'x']), null, 'deterministic')).toBe(true);
  });

  it('turns to force when the run shows deterministic phases', () => {
    const deterministic = reduceRunEvents(
      initialCockpitState('run-1', 'research'),
      numbered([ev('goal_echo'), ev('search_completed')]),
    ).state;
    const agentic = reduceRunEvents(
      initialCockpitState('run-1', 'research'),
      numbered([ev('goal_echo'), ev('tool_started'), ev('tool_finished'), ev('search_completed')]),
    ).state;

    expect(stopIsGraceful(requested(['research', 'q']), deterministic)).toBe(false);
    expect(stopIsGraceful(requested(['research', 'q']), agentic)).toBe(true);
  });

  it('explains force in a tooltip, in words', async () => {
    render(<StopControl graceful={false} stopping={false} onStop={() => undefined} />);

    await userEvent.tab();

    expect(document.activeElement?.textContent).toBe('Stop (force)');
    expect((await screen.findByRole('tooltip')).textContent).toBe(FORCE_STOP_TEXT);
  });

  it('says what force means while stopping', () => {
    const state = reduceRunEvents(initialCockpitState('run-1'), numbered([ev('goal_echo')])).state;

    const displayed = deriveDisplayedState({
      invocation: null,
      connection: { status: 'connected' },
      channel: { state: 'live' },
      cockpit: state,
      stopping: true,
      gracefulStop: false,
    });

    expect(displayed.kind).toBe('stopping');
    expect(displayed.detail).toMatch(/end it after 10 seconds and record the run as interrupted/u);
  });
});

describe('@no-llm Stop in the cockpit', () => {
  it('sends one cancel for a running run and shows stopping', async () => {
    const { rpc } = host(['do', 'fill the form']);
    const stop = await cockpit(rpc);
    expect(stop.textContent).toBe('Stop');

    await userEvent.click(stop);
    await userEvent.click(stop);

    expect(rpc.paramsOf('command.cancel')).toEqual([{ invocation_id: ID }]);
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Run status: stopping' })).toBeDefined();
    });
    const pressed = screen.getByRole('button', { name: /Stopping/u });
    expect(
      pressed.hasAttribute('disabled') || pressed.getAttribute('data-disabled') === 'true',
    ).toBe(true);
  });

  it('ends stopping when the run records aborted', async () => {
    const { rpc, push } = host(['do', 'fill the form']);
    await userEvent.click(await cockpit(rpc));

    push(
      2,
      ev('run_outcome', {
        task_outcome: 'aborted',
        termination_reason: 'user_abort',
        exit_code: 130,
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Run status: finished' })).toBeDefined();
    });
    expect(screen.getByText('The run ended aborted.')).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Stop/u })).toBeNull();
  });

  it('shows a forced stop ending interrupted, in the CLI’s words', async () => {
    const { rpc, push } = host(['research', 'q', '--no-llm']);
    const stop = await cockpit(rpc);
    expect(stop.textContent).toBe('Stop (force)');
    await userEvent.click(stop);
    await waitFor(() => {
      expect(screen.getByText(/end it after 10 seconds/u)).toBeDefined();
    });

    push(
      2,
      ev('run_outcome', {
        task_outcome: 'partial',
        termination_reason: 'owner_lost',
        exit_code: 2,
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          'The run ended interrupted · partial: its process was lost and the run was reconciled.',
        ),
      ).toBeDefined();
    });
  });

  it('reads Stop (force) for a research run the host resolves deterministic', async () => {
    const { rpc } = host(['research', 'q']);
    rpc.answer('read.effective_options', {
      path: ['research'],
      mode: 'deterministic',
      options: [],
    });

    await renderAt(`/mission/runs/run-1?invocation=${ID}`, rpc);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Stop/u }).textContent).toBe('Stop (force)');
    });
  });

  it('is never the default focus', async () => {
    const { rpc } = host(['do', 'fill the form']);
    const stop = await cockpit(rpc);

    expect(document.activeElement).not.toBe(stop);
  });

  it('offers no Stop for a run the app did not launch', async () => {
    const { rpc } = host(['do', 'x']);
    await renderAt('/mission/runs/run-1', rpc);
    await screen.findByText('find flights');

    expect(screen.queryByRole('button', { name: /^Stop/u })).toBeNull();
  });

  it('lets the user try again after a refused cancel, and says why', async () => {
    const { rpc } = host(['do', 'fill the form']);
    rpc.answer('command.cancel', () => {
      throw new RpcCallError(
        'command.cancel',
        -32004,
        'There is no queued item.',
        'not_found',
        undefined,
      );
    });
    const stop = await cockpit(rpc);

    await userEvent.click(stop);

    expect((await screen.findByRole('alert')).textContent).toBe('There is no queued item.');
    expect(
      within(screen.getByRole('region', { name: /Run status/u })).queryByText('Stopping…'),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDefined();
  });
});
