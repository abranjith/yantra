import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { EffectiveOptions } from '@yantra/protocol';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  Composer,
  type ComposerProps,
  type ComposerSubmission,
} from '../../../src/features/composer/Composer.js';
import { RpcProvider } from '../../../src/host/app-rpc.js';
import { expectNoAxeViolations } from '../../support/axe.js';
import { FakeRpc, renderAt } from '../../support/fake-rpc.js';

const HOME = process.platform === 'win32' ? 'C:\\Users\\u' : '/home/u';

/** A host that resolves options like the real read, for the fields under test. */
function composerHost(): FakeRpc {
  return new FakeRpc()
    .answer('read.mission_context', { home: HOME, platform: process.platform })
    .answer('read.template.list', {
      schema: null,
      value: { kind: 'template_list', items: [{ name: 'weekly-digest' }, { name: 'comparison' }] },
      next_cursor: null,
    })
    .answer('read.effective_options', (params): EffectiveOptions => {
      const argv = params.argv as string[];
      const deterministic = argv.includes('--no-llm');
      return {
        path: params.path as string[],
        mode: deterministic ? 'deterministic' : 'llm',
        options: [
          ...(deterministic
            ? []
            : [
                {
                  option: 'model',
                  flag: '--model',
                  value: 'claude-haiku-4-5',
                  source: { kind: 'env', name: 'YANTRA_AGENT_MODEL' } as const,
                },
              ]),
          {
            option: 'length',
            flag: '--length',
            value: 'long',
            source: { kind: 'preference', key: 'defaults.length' } as const,
          },
        ],
      };
    });
}

function renderComposer(rpc: FakeRpc, props: ComposerProps = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (children: ReactNode) => (
    <RpcProvider rpc={rpc}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </RpcProvider>
  );
  return render(wrap(<Composer {...props} />));
}

async function openOptions(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /^Options/u }));
}

function shownFlags(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-field]')].map(
    (node) => node.dataset.field ?? '',
  );
}

describe('@no-llm composer', () => {
  it('swaps the fields when the mode changes', async () => {
    renderComposer(composerHost());
    await openOptions();
    expect(shownFlags()).not.toContain('--no-browse');

    await userEvent.click(screen.getByRole('tab', { name: 'Research' }));
    await userEvent.click(screen.getByRole('button', { name: /^Options/u }));

    await waitFor(() => {
      expect(shownFlags()).toContain('--no-browse');
    });
    expect(screen.getByRole('textbox', { name: /Topic/u })).toBeDefined();
  });

  it('shows each effective value with where it came from', async () => {
    renderComposer(composerHost());
    await openOptions();

    await waitFor(() => {
      expect(screen.getByText('claude-haiku-4-5 · from YANTRA_AGENT_MODEL')).toBeDefined();
    });
    expect(screen.getByText('long · from preference defaults.length')).toBeDefined();
  });

  it('hides the model options when No LLM is switched on', async () => {
    renderComposer(composerHost());
    await openOptions();
    expect(shownFlags()).toContain('--model');

    await userEvent.click(screen.getByRole('switch', { name: 'No LLM' }));

    await waitFor(() => {
      expect(shownFlags()).not.toContain('--model');
    });
  });

  it('previews the exact command as a CLI twin', async () => {
    renderComposer(composerHost());

    await userEvent.type(screen.getByRole('textbox', { name: /Question/u }), 'what is new');

    await waitFor(() => {
      expect(document.querySelector('[data-part="command"]')?.textContent).toMatch(
        /yantra ask 'what is new'|yantra ask "what is new"/u,
      );
    });
  });

  it('asks before using a dangerous option, with Cancel focused first', async () => {
    const onSubmit = vi.fn((_: ComposerSubmission) => Promise.resolve());
    renderComposer(composerHost(), {
      initialPath: 'resume',
      initialValues: { resume: { positional: 'run-1', options: { force: true } } },
      onSubmit,
    });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Resume' })).toBeDefined();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Start with these options?' });
    expect(document.activeElement?.textContent).toBe('Cancel');
    expect(within(dialog).getByText(/without the consent check/u)).toBeDefined();
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Start' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(
      onSubmit.mock.calls[0]![0].model.fields.find((field) => field.flag === '--force')?.value,
    ).toBe(true);
  });

  it('says what is missing only after a submit attempt', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    renderComposer(composerHost(), { onSubmit });
    expect(screen.queryByText('Enter a query.')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(await screen.findByText('Enter a query.')).toBeDefined();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('can be completed with the keyboard alone', async () => {
    const onSubmit = vi.fn((_: ComposerSubmission) => Promise.resolve());
    renderComposer(composerHost(), { onSubmit });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Ask' })).toBeDefined();
    });

    await userEvent.tab();
    await userEvent.tab();
    await userEvent.keyboard('what is new');
    let guard = 0;
    while ((document.activeElement as HTMLElement | null)?.textContent !== 'Start' && guard < 30) {
      await userEvent.tab();
      guard += 1;
    }
    await userEvent.keyboard('{Enter}');

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]![0].model.positional.value).toBe('what is new');
    expect(onSubmit.mock.calls[0]![0].cwd).toBe(HOME);
  });

  it('has no axe violations with the options open', async () => {
    const { container } = renderComposer(composerHost());
    await openOptions();
    await waitFor(() => {
      expect(screen.getByText('long · from preference defaults.length')).toBeDefined();
    });

    await expectNoAxeViolations(container);
  });
});

describe('@no-llm Mission route', () => {
  it('is the start page: / lands on /mission and the nav names it', async () => {
    const { router } = await renderAt('/', composerHost());

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/mission');
    });
    expect(screen.getByRole('heading', { name: 'Mission' })).toBeDefined();
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
        name: 'Mission',
      }),
    ).toBeDefined();
  });
});
