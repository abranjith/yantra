import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ProviderReadiness } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import { composerArgv } from '../../../src/features/composer/composer-model.js';
import { Composer, type ComposerSubmission } from '../../../src/features/composer/Composer.js';
import { mergeParams } from '../../../src/features/composer/run-mode.js';
import { RpcProvider } from '../../../src/host/app-rpc.js';
import { FakeRpc } from '../../support/fake-rpc.js';

const HOME = process.platform === 'win32' ? 'C:\\Users\\u' : '/home/u';

function host(readiness: ProviderReadiness): FakeRpc {
  return new FakeRpc()
    .answer('read.mission_context', { home: HOME, platform: process.platform })
    .answer('read.template.list', { schema: null, value: { items: [] }, next_cursor: null })
    .answer('read.effective_options', (params) => ({ path: params.path, mode: 'llm', options: [] }))
    .answer('read.provider_readiness', readiness)
    .answer('read.list', {
      schema: 'ListResult',
      value: {
        schemaVersion: '0.2',
        kind: 'list',
        items: [
          {
            kind: 'workflow',
            name: 'nightly',
            stepCount: 3,
            securityClass: 'public',
            modifiedAt: '2026-11-01',
          },
          {
            kind: 'workflow',
            name: 'prices',
            stepCount: 5,
            securityClass: 'public',
            modifiedAt: '2026-11-02',
          },
        ],
      },
      next_cursor: null,
    })
    .answer('read.workflow_params', (params) => ({
      name: params.name,
      params:
        params.name === 'nightly'
          ? [
              { key: 'city', type: 'string', required: true, example: 'Pune' },
              { key: 'limit', type: 'number', required: false, example: null },
            ]
          : [],
    }));
}

function renderComposer(
  rpc: FakeRpc,
  onSubmit = vi.fn((_: ComposerSubmission) => Promise.resolve()),
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <RpcProvider rpc={rpc}>
      <QueryClientProvider client={client}>
        <Composer onSubmit={onSubmit} />
      </QueryClientProvider>
    </RpcProvider>,
  );
  return onSubmit;
}

const NOT_READY: ProviderReadiness = {
  ready: false,
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  reason: 'No credential for anthropic is set up on this computer.',
  fix: { label: 'Set up anthropic', path: ['init'], argv: [] },
};

describe('@no-llm Do mode', () => {
  it('cannot start without a provider, and says why with the fix to copy', async () => {
    const rpc = host(NOT_READY);
    const onSubmit = renderComposer(rpc);

    await userEvent.click(screen.getByRole('tab', { name: 'Do' }));
    await userEvent.type(screen.getByRole('textbox', { name: /Goal/u }), 'fill the form');

    const note = await screen.findByRole('note');
    expect(note.textContent).toContain(
      'Do needs a model. No credential for anthropic is set up on this computer.',
    );
    expect(within(note).getByText('Set up anthropic')).toBeDefined();
    expect(note.querySelector('[data-part="command"]')?.textContent).toBe('yantra init');
    const start = screen.getByRole('button', { name: 'Start' });
    expect(start.hasAttribute('disabled') || start.getAttribute('data-disabled') === 'true').toBe(
      true,
    );
    await userEvent.click(start);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(rpc.paramsOf('read.provider_readiness')[0]).toMatchObject({ path: ['do'], cwd: HOME });
  });

  it('starts when a provider is ready', async () => {
    const onSubmit = renderComposer(
      host({ ready: true, provider: 'anthropic', model: 'claude-haiku-4-5' }),
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Do' }));
    await userEvent.type(screen.getByRole('textbox', { name: /Goal/u }), 'fill the form');
    await waitFor(() => {
      expect(screen.queryByRole('note')).toBeNull();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
  });

  it('never asks about the provider outside Do', async () => {
    const rpc = host(NOT_READY);
    renderComposer(rpc);

    await userEvent.type(screen.getByRole('textbox', { name: /Question/u }), 'q');

    expect(rpc.paramsOf('read.provider_readiness')).toEqual([]);
  });
});

describe('@no-llm Run mode', () => {
  async function pick(name: string): Promise<void> {
    await userEvent.click(screen.getByRole('tab', { name: 'Run' }));
    await userEvent.click(screen.getByRole('button', { name: /Show suggestions|Workflow/u }));
    await userEvent.click(await screen.findByRole('option', { name }));
  }

  it('renders the declared params of the chosen workflow', async () => {
    renderComposer(host(NOT_READY));

    await pick('nightly');

    expect(await screen.findByRole('textbox', { name: /^city/u })).toBeDefined();
    expect(screen.getByRole('textbox', { name: /^limit/u })).toBeDefined();
    expect(screen.getByText('string, e.g. Pune')).toBeDefined();
  });

  it('blocks Start until a required param has a value, then sends --params in declared order', async () => {
    const onSubmit = renderComposer(host(NOT_READY));
    await pick('nightly');
    await screen.findByRole('textbox', { name: /^city/u });

    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Enter city; the workflow needs it.')).toBeDefined();
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.type(screen.getByRole('textbox', { name: /^limit/u }), '5');
    await userEvent.type(screen.getByRole('textbox', { name: /^city/u }), 'Pune');
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(composerArgv(onSubmit.mock.calls[0]![0].model)).toEqual([
      'nightly',
      '--params',
      'city=Pune',
      '--params',
      'limit=5',
    ]);
  });

  it('says when a workflow takes no params', async () => {
    renderComposer(host(NOT_READY));

    await pick('prices');

    expect(await screen.findByText('This workflow takes no params.')).toBeDefined();
  });
});

describe('@no-llm workflow params', () => {
  it('keeps typed values for the same keys and drops the rest', () => {
    expect(
      mergeParams(
        [
          { key: 'a', type: 'string', required: true, example: null },
          { key: 'b', type: 'number', required: false, example: null },
        ],
        [
          { key: 'b', type: 'number', required: false, value: '3' },
          { key: 'gone', type: 'string', required: false, value: 'x' },
        ],
      ),
    ).toEqual([
      { key: 'a', type: 'string', required: true, value: '' },
      { key: 'b', type: 'number', required: false, value: '3' },
    ]);
  });
});
