import { act, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from '../../src/primitives/Button.js';
import {
  createToastQueue,
  TOAST_TIMEOUT_MS,
  TOAST_TONES,
  ToastProvider,
  type DrshyaToastQueue,
  type ToastTone,
} from '../../src/primitives/Toast.js';

function App({ queue, label }: { readonly queue: DrshyaToastQueue; readonly label?: string }) {
  return (
    <ToastProvider queue={queue} {...(label === undefined ? {} : { 'aria-label': label })}>
      <Button>Work</Button>
    </ToastProvider>
  );
}

function toasts(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-tone]')];
}

describe('@no-llm Drshya Toast', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never moves focus when a toast is added', async () => {
    const queue = createToastQueue();
    render(<App queue={queue} />);
    await userEvent.tab();
    const focused = document.activeElement;
    expect(focused).toBe(screen.getByRole('button', { name: 'Work' }));

    act(() => {
      queue.add({ tone: 'info', title: 'Saved' });
    });

    expect(toasts()).toHaveLength(1);
    expect(document.activeElement).toBe(focused);
  });

  it('renders the region as a labelled landmark with polite live semantics', () => {
    const queue = createToastQueue();
    render(<App queue={queue} />);

    act(() => {
      queue.add({ tone: 'fulfilled', title: 'Run fulfilled' });
    });

    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(within(region).getByText('Run fulfilled')).toBeDefined();
    const content = within(region).getByRole('status');
    expect(content.getAttribute('aria-live')).toBe('polite');
    expect(content.getAttribute('aria-atomic')).toBe('true');
    expect(region.querySelector('[role="alert"]')).toBeNull();
  });

  it('dismisses a plain toast after 6 s', () => {
    vi.useFakeTimers();
    const queue = createToastQueue();
    render(<App queue={queue} />);

    act(() => {
      queue.add({ tone: 'info', title: 'Saved' });
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_TIMEOUT_MS - 1);
    });
    expect(toasts()).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(toasts()).toHaveLength(0);
    expect(TOAST_TIMEOUT_MS).toBe(6000);
  });

  it('never auto-dismisses a toast with an action (WCAG 2.2.1)', () => {
    vi.useFakeTimers();
    const queue = createToastQueue();
    render(<App queue={queue} />);

    act(() => {
      queue.add({
        tone: 'needs-you',
        title: 'Confirmation needed',
        action: { label: 'Review', onAction: () => undefined },
      });
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_TIMEOUT_MS * 20);
    });

    expect(toasts()).toHaveLength(1);
  });

  it('closes a toast from its close button', async () => {
    const queue = createToastQueue();
    render(<App queue={queue} />);
    act(() => {
      queue.add({ tone: 'failed', title: 'Run failed' });
    });

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(toasts()).toHaveLength(0);
  });

  it('runs an action and closes its toast', async () => {
    const onAction = vi.fn();
    const queue = createToastQueue();
    render(<App queue={queue} />);
    act(() => {
      queue.add({ tone: 'needs-you', title: 'Confirm', action: { label: 'Review', onAction } });
    });

    await userEvent.click(screen.getByRole('button', { name: 'Review' }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(toasts()).toHaveLength(0);
  });

  it.each(Object.keys(TOAST_TONES) as ToastTone[])(
    'renders the %s tone with its icon and a word, not color alone',
    (tone) => {
      const queue = createToastQueue({ autoDismiss: false });
      render(<App queue={queue} />);

      act(() => {
        queue.add({ tone, title: `A ${tone} toast` });
      });

      const toast = toasts()[0];
      expect(toast?.querySelector(`svg[data-icon="${TOAST_TONES[tone].icon}"]`)).not.toBeNull();
      expect(toast?.textContent).toContain(TOAST_TONES[tone].label);
      expect(toast?.className).toContain('glass');
    },
  );

  it('shows title and description', () => {
    const queue = createToastQueue();
    render(<App queue={queue} />);

    act(() => {
      queue.add({
        tone: 'partial',
        title: 'Partially fulfilled',
        description: 'One source unverified.',
      });
    });

    expect(screen.getByText('Partially fulfilled')).toBeDefined();
    expect(screen.getByText('One source unverified.')).toBeDefined();
  });

  it('keeps two providers with two queues apart (no singleton)', () => {
    const first = createToastQueue();
    const second = createToastQueue();
    render(
      <>
        <App queue={first} label="First notifications" />
        <App queue={second} label="Second notifications" />
      </>,
    );

    act(() => {
      first.add({ tone: 'info', title: 'Only in the first' });
    });

    expect(
      within(screen.getByRole('region', { name: 'First notifications' })).getByText(
        'Only in the first',
      ),
    ).toBeDefined();
    expect(screen.queryAllByRole('region', { name: 'Second notifications' })).toHaveLength(0);
  });

  it('clears every toast', () => {
    const queue = createToastQueue({ autoDismiss: false });
    render(<App queue={queue} />);
    act(() => {
      queue.add({ tone: 'info', title: 'One' });
      queue.add({ tone: 'info', title: 'Two' });
    });

    act(() => {
      queue.clear();
    });

    expect(toasts()).toHaveLength(0);
  });

  it('limits how many toasts show at once', () => {
    const queue = createToastQueue({ maxVisibleToasts: 2, autoDismiss: false });
    render(<App queue={queue} />);

    act(() => {
      for (const title of ['One', 'Two', 'Three']) {
        queue.add({ tone: 'info', title });
      }
    });

    expect(toasts()).toHaveLength(2);
  });
});
