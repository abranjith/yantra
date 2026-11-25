// @no-llm
/**
 * The command palette in the real app (router, shell, host answers shaped as
 * the host's): what it offers before you type, search as you type, starting
 * a run with the typed goal, and running a command line.
 */

import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { cliDocument, readAnswer } from '../support/cli-documents.js';
import { FakeRpc, renderAt } from '../support/fake-rpc.js';
import { useFixedLayout } from '../support/layout.js';

useFixedLayout(1200, 600);

const HOME = process.platform === 'win32' ? 'C:\\Users\\u' : '/home/u';

function host(): FakeRpc {
  return new FakeRpc()
    .answer('read.config.path', readAnswer('ConfigPathResult', cliDocument('config.path.action')))
    .answer('read.model.list', readAnswer('ModelListResult', cliDocument('model.list.action')))
    .answer('read.sites.list', readAnswer('SitesListResult', cliDocument('sites.list.action')))
    .answer('read.mission_context', { home: HOME, platform: process.platform })
    .answer('read.template.list', { schema: null, value: { items: [] }, next_cursor: null })
    .answer('read.effective_options', (params) => ({ path: params.path, mode: 'llm', options: [] }))
    .answer('read.onboarding_status', { config_exists: true });
}

async function openPalette() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Search or type a command' }));
  const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
  return { user, dialog };
}

describe('@no-llm the command palette', () => {
  it('says what it is for before anything is typed', async () => {
    await renderAt('/settings/data', host());
    const { dialog } = await openPalette();

    const field = within(dialog).getByRole('searchbox', {
      name: 'Search Yantra or type a command',
    });
    expect(field.getAttribute('placeholder')).toBe('Search pages and actions, or type a command');
    expect(within(dialog).getByRole('menuitem', { name: /Ask a question/u })).toBeTruthy();
    expect(within(dialog).getByRole('menuitem', { name: /Ledger/u })).toBeTruthy();
    expect(within(dialog).getByText(/You can also type a command/u)).toBeTruthy();
  });

  it('finds a page as you type and opens it with Enter', async () => {
    const { router } = await renderAt('/settings/data', host());
    const { user, dialog } = await openPalette();

    await user.type(within(dialog).getByRole('searchbox'), 'models');
    expect(within(dialog).getByRole('menuitem', { name: /^Models/u })).toBeTruthy();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/models');
    });
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  });

  it('starts an Ask with the typed question filled in', async () => {
    const { router } = await renderAt('/settings/data', host());
    const { user, dialog } = await openPalette();

    await user.type(within(dialog).getByRole('searchbox'), 'tallest building in Lisbon');
    await user.click(
      within(dialog).getByRole('menuitem', { name: /Ask “tallest building in Lisbon”/u }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/mission');
    });
    expect(router.state.location.search).toMatchObject({
      mode: 'ask',
      goal: 'tallest building in Lisbon',
    });
    const question = await screen.findByRole('textbox', { name: /Question/u });
    expect((question as HTMLTextAreaElement).value).toBe('tallest building in Lisbon');
  });

  it('runs "yantra ask" with an unquoted question, quoting it, and opens the run', async () => {
    const rpc = host()
      .answer('command.invoke', { invocation_id: '01JBBBBBBBBBBBBBBBBBBBBBBB' })
      .answer('read.invocation', { invocation_id: '01JBBBBBBBBBBBBBBBBBBBBBBB', state: 'queued' });
    const { router } = await renderAt('/settings/data', rpc);
    const { user, dialog } = await openPalette();

    await user.type(
      within(dialog).getByRole('searchbox'),
      "yantra ask summarize today's stock market",
    );
    expect(
      within(dialog).getByRole('menuitem', { name: /Ask “summarize today's stock market”/u }),
    ).toBeTruthy();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        '/mission/invocations/01JBBBBBBBBBBBBBBBBBBBBBBB',
      );
    });
    const [call] = rpc.paramsOf('command.invoke');
    expect(call?.invocation).toMatchObject({
      path: ['ask'],
      argv: ["summarize today's stock market"],
    });
  });

  it('says why when Enter has nothing it can run', async () => {
    await renderAt('/settings/data', host());
    const { user, dialog } = await openPalette();

    await user.type(within(dialog).getByRole('searchbox'), "yantra sites add 'example.com");
    await user.keyboard('{Enter}');

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'A quote is opened and never closed. Close it, or take it out.',
    );
  });

  it('runs a command line and opens the page it changed', async () => {
    const rpc = host().answer('command.invoke', { invocation_id: '01JAAAAAAAAAAAAAAAAAAAAAAA' });
    const { router } = await renderAt('/settings/data', rpc);
    const { user, dialog } = await openPalette();

    await user.type(within(dialog).getByRole('searchbox'), 'yantra sites add example.com');
    expect(within(dialog).getByText('Runs now, then opens the page it changes.')).toBeTruthy();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/sites');
    });
    const [call] = rpc.paramsOf('command.invoke');
    expect((call?.invocation as { path: string[] }).path).toEqual(['sites', 'add']);
  });
});
