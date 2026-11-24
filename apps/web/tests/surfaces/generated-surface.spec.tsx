// @no-llm
/**
 * Generated surfaces over answers shaped exactly like the host's (FEAT-070):
 * the CLI's recorded `--json` documents, wrapped and validated with the
 * protocol schemas the host uses. The Installation table once derived its
 * columns from the envelope and showed a schema sentence over every column
 * and "—" in every cell; these tests render what a person sees.
 */

import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { RpcCallError } from '../../src/host/rpc-client.js';
import {
  cliDocument,
  readAnswer,
  workflowList,
  workflowListAnswer,
} from '../support/cli-documents.js';
import { FakeRpc, renderAt } from '../support/fake-rpc.js';
import { useFixedLayout } from '../support/layout.js';

useFixedLayout(1200, 600);

function installationHost(): FakeRpc {
  return new FakeRpc()
    .answer('read.config.path', readAnswer('ConfigPathResult', cliDocument('config.path.action')))
    .answer('read.config.list', readAnswer('ConfigListResult', cliDocument('config.list.action')))
    .answer(
      'read.config.validate',
      readAnswer('ConfigValidateResult', cliDocument('config.validate.action')),
    );
}

describe('@no-llm Installation', () => {
  it('shows each storage location by name, path and source, with no row actions', async () => {
    await renderAt('/settings/installation', installationHost());

    const table = await screen.findByRole('grid', { name: 'Storage locations' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(headers).toEqual(['Name', 'Path', 'Source']);
    expect(within(table).getByRole('rowheader', { name: 'home' })).toBeDefined();
    expect(within(table).getAllByText('env:YANTRA_HOME').length).toBeGreaterThan(0);
    expect(within(table).queryByRole('button', { name: 'Get' })).toBeNull();
  });

  it('shows config.yaml and its validation as records without the envelope', async () => {
    await renderAt('/settings/installation', installationHost());

    const config = await screen.findByRole('group', { name: 'config.yaml' });
    // `{config: {…}}` is unwrapped: its fields are the labels.
    expect(within(config).getByText('Models')).toBeDefined();
    expect(within(config).queryByText('Config')).toBeNull();
    const validation = await screen.findByRole('group', { name: 'Validation' });
    expect(within(validation).getByText('Valid')).toBeDefined();
    // A path reads as text, not as a JSON string with doubled backslashes.
    const path = (cliDocument('config.validate.action') as { path: string }).path;
    expect(within(validation).getByText(path)).toBeDefined();
    expect(within(validation).queryByText(/Schema version/u)).toBeNull();
  });

  it('offers set, look up and remove in plain words, with one primary action', async () => {
    await renderAt('/settings/installation', installationHost());

    for (const name of ['Set a value', 'Look up a value', 'Remove a value']) {
      expect(await screen.findByRole('button', { name })).toBeDefined();
    }
    expect(screen.getByRole('heading', { level: 1, name: 'Installation' })).toBeDefined();
    expect(screen.getByText('Settings · Setup')).toBeDefined();
  });

  it('shows the exact command an action runs on focus, and opens its form on press', async () => {
    const user = userEvent.setup();
    await renderAt('/settings/installation', installationHost());
    const button = await screen.findByRole('button', { name: 'Set a value' });

    // Keyboard focus opens a tooltip at once (hover waits, and jsdom has no real pointer).
    await user.keyboard('{Shift}');
    act(() => {
      button.focus();
    });
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toBe('yantra config set <key> <value>');
    await user.keyboard('{Escape}');

    await user.click(button);
    expect(await screen.findByRole('dialog', { name: 'Set a value' })).toBeDefined();
  });

  it('says why a read failed, with the host’s remediation', async () => {
    const rpc = installationHost().answer('read.config.validate', () => {
      throw new RpcCallError(
        'read.config.validate',
        -32004,
        'config.yaml is invalid: models.0.id is required.',
        'not_found',
        'Fix it with yantra config edit.',
      );
    });
    await renderAt('/settings/installation', rpc);

    expect(
      await screen.findByText(/models\.0\.id is required\. Fix it with yantra config edit\./u),
    ).toBeDefined();
  });

  it('opens the raw editor on the current config.yaml, never an empty one', async () => {
    const user = userEvent.setup();
    await renderAt('/settings/installation', installationHost());

    await user.click(await screen.findByRole('button', { name: 'Edit config.yaml' }));

    const editor = await screen.findByRole('textbox', { name: 'Raw YAML or JSON' });
    await waitFor(() => {
      expect((editor as HTMLTextAreaElement).value).toContain('"fallback_chain"');
    });
    expect(screen.getByRole('button', { name: 'Save and validate' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('keeps Save disabled when config.yaml could not be read', async () => {
    const user = userEvent.setup();
    const rpc = installationHost().answer('read.config.list', () => {
      throw new Error('The host is gone.');
    });
    await renderAt('/settings/installation', rpc);

    await user.click(await screen.findByRole('button', { name: 'Edit config.yaml' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit config.yaml' });
    expect(
      await within(dialog).findByText(/Couldn’t load config\.yaml\. The host is gone\./u),
    ).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Save and validate' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('@no-llm Workflows', () => {
  it('lists saved workflows through the query read.list accepts', async () => {
    const rpc = new FakeRpc().answer(
      'read.list',
      workflowListAnswer(workflowList('nightly', 'prices')),
    );
    await renderAt('/workflows', rpc);

    const table = await screen.findByRole('grid', { name: 'Saved workflows' });
    expect(within(table).getByRole('rowheader', { name: 'nightly' })).toBeDefined();
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(headers).not.toContain('Kind');
    expect(rpc.paramsOf('read.list')).toEqual([{ target: 'workflows' }]);
  });
});

describe('@no-llm Daemon', () => {
  it('shows the bare status document as a record', async () => {
    const rpc = new FakeRpc().answer(
      'read.daemon.status',
      readAnswer('DaemonStatusResult', cliDocument('daemon.status.action')),
    );
    await renderAt('/daemon', rpc);

    const status = await screen.findByRole('group', { name: 'Status' });
    expect(within(status).getByText('Running')).toBeDefined();
    expect(within(status).getByText('Schedules loaded')).toBeDefined();
    // An empty list reads as words, not `[0]`.
    expect(within(status).getByText('None')).toBeDefined();
  });
});
