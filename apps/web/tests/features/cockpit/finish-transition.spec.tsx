import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  RESULT_HEADING_SELECTOR,
  finishTransition,
  shouldHoldFinish,
  type FinishDocument,
} from '../../../src/features/cockpit/finish-transition.js';
import { buildComposerModel } from '../../../src/features/composer/composer-model.js';
import { submitInvocation, wasLaunchedHere } from '../../../src/features/composer/submit.js';
import { FakeRpc, renderAt } from '../../support/fake-rpc.js';
import { ev, numbered } from '../../support/run-events.js';

/** A stand-in over the real document, optionally with a View Transitions API. */
function doc(withTransitions: boolean): { doc: FinishDocument; started: ReturnType<typeof vi.fn> } {
  const started = vi.fn((update: () => Promise<void> | void) => ({
    finished: Promise.resolve(update()).then(() => undefined),
  }));
  const value: FinishDocument = {
    get activeElement() {
      return document.activeElement;
    },
    body: document.body,
    documentElement: document.documentElement,
    contains: (node) => document.contains(node),
    querySelector: (selector) => document.querySelector(selector),
    ...(withTransitions ? { startViewTransition: started } : {}),
  };
  return { doc: value, started };
}

describe('@no-llm finishTransition', () => {
  it('navigates inside a View Transition when the browser has one', async () => {
    const { doc: d, started } = doc(true);
    const navigate = vi.fn();

    expect(await finishTransition({ navigate, reducedMotion: false, doc: d })).toBe('navigated');

    expect(started).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('navigates plainly without the API, under reduced motion, or with Solid surfaces', async () => {
    const plain = doc(false);
    const reduced = doc(true);
    const solid = doc(true);
    document.documentElement.dataset.surfaces = 'solid';
    const navigate = vi.fn();

    await finishTransition({ navigate, reducedMotion: false, doc: plain.doc });
    await finishTransition({ navigate, reducedMotion: true, doc: reduced.doc });
    await finishTransition({ navigate, reducedMotion: false, doc: solid.doc });
    delete document.documentElement.dataset.surfaces;

    expect(navigate).toHaveBeenCalledTimes(3);
    expect(reduced.started).not.toHaveBeenCalled();
    expect(solid.started).not.toHaveBeenCalled();
  });

  it('holds while focus is in the Command panel or a dialog', async () => {
    render(
      <>
        <section data-panel="command">
          <button type="button">Copy</button>
        </section>
        <div role="dialog" aria-label="d">
          <button type="button">In dialog</button>
        </div>
        <button type="button">Elsewhere</button>
      </>,
    );
    const navigate = vi.fn();

    screen.getByRole('button', { name: 'Copy' }).focus();
    expect(await finishTransition({ navigate, reducedMotion: false, doc: doc(false).doc })).toBe(
      'held',
    );
    screen.getByRole('button', { name: 'In dialog' }).focus();
    expect(shouldHoldFinish(document)).toBe(true);
    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    expect(shouldHoldFinish(document)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves focus on body where it was', async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    const waitForHeading = vi.fn(() => Promise.resolve(null));

    await finishTransition({
      navigate: vi.fn(),
      reducedMotion: false,
      doc: doc(false).doc,
      waitForHeading,
    });

    expect(waitForHeading).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it('moves focus to the result heading only when the focused element is gone', async () => {
    const { container, rerender } = render(<button type="button">Keep waiting</button>);
    screen.getByRole('button').focus();
    const heading = document.createElement('h1');
    heading.tabIndex = -1;
    heading.dataset.focusTarget = 'run-heading';

    await finishTransition({
      navigate: () => {
        rerender(<p>gone</p>);
        document.body.append(heading);
      },
      reducedMotion: false,
      doc: doc(false).doc,
      waitForHeading: (d) =>
        Promise.resolve(d.querySelector(RESULT_HEADING_SELECTOR) as HTMLElement),
    });

    expect(document.activeElement).toBe(heading);
    heading.remove();
    expect(container).toBeDefined();
  });

  it('keeps focus that survives the navigation where it is', async () => {
    render(<button type="button">Stays</button>);
    const button = screen.getByRole('button');
    button.focus();

    await finishTransition({ navigate: vi.fn(), reducedMotion: false, doc: doc(false).doc });

    expect(document.activeElement).toBe(button);
  });
});

describe('@no-llm the cockpit finish', () => {
  /** A live run: the test pushes its outcome after the cockpit has seen it running. */
  function live() {
    const rpc = new FakeRpc()
      .answer('run.subscribe', (params) => {
        for (const { seq, event } of numbered([ev('goal_echo'), ev('tool_started')])) {
          rpc.notify('run.event', { run_id: params.run_id, seq, event });
        }
        return { channel: 'live' };
      })
      .answer('run.unsubscribe', {});
    return rpc;
  }

  it('lands on the run result when a watched run ends', async () => {
    const rpc = live();
    const { router } = await renderAt('/mission/runs/run-1', rpc);
    await screen.findByText('find flights');

    act(() => {
      rpc.notify('run.event', { run_id: 'run-1', seq: 3, event: ev('run_outcome') });
    });

    await waitFor(
      () => {
        expect(router.state.location.pathname).toBe('/runs/run-1');
      },
      { timeout: 5_000 },
    );
  });

  it('stays on a run that had already ended when it was opened', async () => {
    const rpc = new FakeRpc()
      .answer('run.subscribe', (params) => {
        for (const { seq, event } of numbered([ev('goal_echo'), ev('run_outcome')])) {
          rpc.notify('run.event', { run_id: params.run_id, seq, event });
        }
        return { channel: 'replay_only' };
      })
      .answer('run.unsubscribe', {});
    const { router } = await renderAt('/mission/runs/run-1', rpc);

    await screen.findByRole('region', { name: 'Run status: finished' });
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });

    expect(router.state.location.pathname).toBe('/mission/runs/run-1');
  });

  it('offers View result instead of leaving while the user works in the Command panel', async () => {
    const rpc = live();
    const { router, container } = await renderAt('/mission/runs/run-1', rpc);
    await screen.findByText('find flights');
    const panel = container.querySelector<HTMLElement>('[data-panel="command"]')!;
    const focusable = document.createElement('button');
    focusable.textContent = 'held focus';
    panel.append(focusable);
    focusable.focus();

    act(() => {
      rpc.notify('run.event', { run_id: 'run-1', seq: 3, event: ev('run_outcome') });
    });

    await waitFor(
      () => {
        expect(container.querySelector('[data-part="announcer"]')?.textContent).toContain(
          'The result is ready. View result opens it.',
        );
      },
      { timeout: 7_000 },
    );
    expect(router.state.location.pathname).toBe('/mission/runs/run-1');
    expect(screen.getByRole('button', { name: 'View result' })).toBeDefined();
    expect(document.activeElement).toBe(focusable);
  });

  /** A run the app launched, already ended in its file, with the invocation in a given state. */
  function launched(state: 'running' | 'finished') {
    const rpc = new FakeRpc()
      .answer('read.invocation', {
        invocation_id: '01JD2X7Q8R9S0T1V2W3X000041',
        state,
        execution_class: 'run',
        path: ['research'],
        run_id: 'run-1',
        queued_at: '2026-11-14T10:00:00.000Z',
        review: null,
        result: null,
      })
      .answer('run.subscribe', (params) => {
        for (const { seq, event } of numbered([ev('goal_echo'), ev('run_outcome')])) {
          rpc.notify('run.event', { run_id: params.run_id, seq, event });
        }
        return { channel: 'replay_only' };
      })
      .answer('run.unsubscribe', {});
    return rpc;
  }

  it('finishes a run launched here even when it ended before the cockpit attached', async () => {
    const { router } = await renderAt(
      '/mission/runs/run-1?invocation=01JD2X7Q8R9S0T1V2W3X000041',
      launched('running'),
    );

    await waitFor(
      () => {
        expect(router.state.location.pathname).toBe('/runs/run-1');
      },
      { timeout: 5_000 },
    );
  });

  it('finishes a run this window launched even when its invocation already reads finished', async () => {
    const rpc = launched('finished').answer('command.invoke', (params) => ({
      ...(params.invocation as object),
      state: 'spawning',
      execution_class: 'run',
      run_id: null,
      queued_at: '2026-11-14T10:00:00.000Z',
      review: null,
      result: null,
    }));
    await submitInvocation(
      rpc,
      {
        model: buildComposerModel({
          path: 'research',
          values: { positional: 'q', options: {} },
          effective: null,
        }),
        effective: null,
        cwd: process.platform === 'win32' ? 'C:\\w' : '/w',
      },
      { createId: () => '01JD2X7Q8R9S0T1V2W3X000041' },
    );

    const { router } = await renderAt(
      '/mission/runs/run-1?invocation=01JD2X7Q8R9S0T1V2W3X000041',
      rpc,
    );

    await waitFor(
      () => {
        expect(router.state.location.pathname).toBe('/runs/run-1');
      },
      { timeout: 5_000 },
    );
    expect(wasLaunchedHere('01JD2X7Q8R9S0T1V2W3X000041')).toBe(false);
  });

  it('stays when a finished app-launched run is opened again', async () => {
    const { router } = await renderAt(
      '/mission/runs/run-1?invocation=01JD2X7Q8R9S0T1V2W3X000041',
      launched('finished'),
    );

    await screen.findByRole('region', { name: 'Run status: finished' });
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });

    expect(router.state.location.pathname).toBe('/mission/runs/run-1');
  });
});
