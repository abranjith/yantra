import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { CredentialListResult } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { AppToasts } from '../../../src/app/shell/toasts.js';
import { RpcProvider } from '../../../src/host/app-rpc.js';
import { CredentialsSurface } from '../../../src/surfaces/settings/credentials/credentials-route.js';
import { expectNoAxeViolations } from '../../support/axe.js';
import { FakeRpc } from '../../support/fake-rpc.js';

const CANARY = 'CANARY_WEB_SECRET_7744';

function renderCredentials(
  listResult: CredentialListResult,
  options: { readonly initialKey?: string } = {},
) {
  const rpc = new FakeRpc();
  rpc.answer('secret.list', listResult);
  rpc.answer('secret.set', (params) => ({ status: 'set', key: params.key }));
  rpc.answer('secret.rm', (params) => ({ status: 'removed', key: params.key }));

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const view = render(
    <QueryClientProvider client={queryClient}>
      <RpcProvider rpc={rpc}>
        <AppToasts>
          <CredentialsSurface initialKey={options.initialKey} />
        </AppToasts>
      </RpcProvider>
    </QueryClientProvider>,
  );

  return { ...view, rpc, queryClient };
}

describe('@no-llm CredentialsSurface', () => {
  it('renders credential names, sources, and ProtectedValue references', async () => {
    const { container } = renderCredentials({
      available: true,
      remedy: null,
      rows: [
        {
          key: 'tavily.api_key',
          source: 'keychain',
          referenced_by: [
            { kind: 'search', id: 'tavily', ref: { kind: 'secret', key: 'tavily.api_key' } },
          ],
        },
        {
          key: 'anthropic/claude-opus-4-7',
          source: 'env',
          referenced_by: [
            {
              kind: 'model',
              id: 'anthropic/claude-opus-4-7',
              ref: { kind: 'env', name: 'ANTHROPIC_API_KEY' },
            },
          ],
        },
      ],
    });

    expect(await screen.findByText('tavily.api_key')).toBeDefined();
    expect(screen.getByText('keychain')).toBeDefined();
    expect(screen.getByText('env')).toBeDefined();
    expect(screen.getByText('${secret:tavily.api_key}')).toBeDefined();
    expect(screen.getByText('${env:ANTHROPIC_API_KEY}')).toBeDefined();
    expect(container.querySelectorAll('[data-part="protected-value"]')).toHaveLength(2);
    await expectNoAxeViolations(container);
  });

  it('requires explicit confirmation when removing a referenced credential, and single-confirms unreferenced ones', async () => {
    const user = userEvent.setup();
    const { rpc } = renderCredentials({
      available: true,
      remedy: null,
      rows: [
        {
          key: 'tavily.api_key',
          source: 'keychain',
          referenced_by: [
            { kind: 'search', id: 'tavily', ref: { kind: 'secret', key: 'tavily.api_key' } },
          ],
        },
        {
          key: 'unused.api_key',
          source: 'keychain',
          referenced_by: [],
        },
      ],
    });

    await screen.findByText('tavily.api_key');
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    expect(removeButtons).toHaveLength(2);

    // Referenced credential requires checkbox confirmation
    await user.click(removeButtons[0]!);
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('search tavily')).toBeDefined();
    const confirmRemoveBtn = within(dialog).getByRole('button', { name: 'Remove credential' });
    expect((confirmRemoveBtn as HTMLButtonElement).disabled).toBe(true);

    await user.click(within(dialog).getByRole('checkbox'));
    expect((confirmRemoveBtn as HTMLButtonElement).disabled).toBe(false);
    await user.click(confirmRemoveBtn);

    await waitFor(() => {
      expect(
        rpc.calls.some((c) => c.method === 'secret.rm' && c.params.key === 'tavily.api_key'),
      ).toBe(true);
    });

    // Unreferenced credential allows single confirm
    const removeButtonsAfter = screen.getAllByRole('button', { name: 'Remove' });
    await user.click(removeButtonsAfter[1]!);
    const singleConfirmBtn = screen.getByRole('button', { name: 'Remove credential' });
    expect((singleConfirmBtn as HTMLButtonElement).disabled).toBe(false);
    await user.click(singleConfirmBtn);

    await waitFor(() => {
      expect(
        rpc.calls.some((c) => c.method === 'secret.rm' && c.params.key === 'unused.api_key'),
      ).toBe(true);
    });
  });

  it('disables Set and Remove actions and displays remedy when keychain is unavailable', async () => {
    renderCredentials({
      available: false,
      remedy: 'unlock the login keychain, or use a ${env:NAME} reference',
      rows: [
        {
          key: 'tavily.api_key',
          source: 'keychain',
          referenced_by: [],
        },
      ],
    });

    expect(await screen.findByText('OS keychain unavailable')).toBeDefined();
    expect(screen.getByText(/unlock the login keychain/u)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Set credential' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Replace' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Remove' }).disabled).toBe(true);
  });

  it('keeps submitted canary out of DOM, query/mutation cache, sessionStorage, and localStorage', async () => {
    sessionStorage.clear();
    localStorage.clear();
    const user = userEvent.setup();
    const { container, rpc, queryClient } = renderCredentials(
      {
        available: true,
        remedy: null,
        rows: [],
      },
      { initialKey: 'tavily.api_key' },
    );

    const keyInput = await screen.findByLabelText(/Credential key/u);
    expect((keyInput as HTMLInputElement).value).toBe('tavily.api_key');

    const secretInput = screen.getByLabelText(/Secret value/u);
    await user.type(secretInput, CANARY);
    await user.click(screen.getByRole('button', { name: 'Store credential' }));

    await waitFor(() => {
      expect(
        rpc.calls.some(
          (c) =>
            c.method === 'secret.set' &&
            c.params.key === 'tavily.api_key' &&
            c.params.value === CANARY,
        ),
      ).toBe(true);
    });

    // Dialog closes and toast renders without canary
    await waitFor(() => {
      expect(screen.getByText('Stored tavily.api_key.')).toBeDefined();
    });

    expect(container.innerHTML).not.toContain(CANARY);
    expect(document.body.innerHTML).not.toContain(CANARY);

    const queriesJson = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => ({ queryKey: q.queryKey, data: q.state.data })),
    );
    expect(queriesJson).not.toContain(CANARY);

    const mutationsJson = JSON.stringify(
      queryClient
        .getMutationCache()
        .getAll()
        .map((m) => ({
          mutationKey: m.options.mutationKey,
          variables: m.state.variables,
          data: m.state.data,
        })),
    );
    expect(mutationsJson).not.toContain(CANARY);

    for (let i = 0; i < sessionStorage.length; i += 1) {
      const k = sessionStorage.key(i)!;
      expect(k).not.toContain(CANARY);
      expect(sessionStorage.getItem(k)).not.toContain(CANARY);
    }
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i)!;
      expect(k).not.toContain(CANARY);
      expect(localStorage.getItem(k)).not.toContain(CANARY);
    }
  });
});
