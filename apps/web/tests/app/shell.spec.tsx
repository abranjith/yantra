// @no-llm
/**
 * The app shell (FEAT-065 TASK-011): navigation from the registry, the
 * connection live region, and the session-ended view.
 */

import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { locate, navigationPaths, UNLISTED_PATHS } from '../../src/app/navigation.js';
import { makeRouter } from '../../src/app/router.js';
import { AppShell } from '../../src/app/shell/AppShell.js';
import { ConnectionBanner, connectionMessage } from '../../src/app/shell/ConnectionBanner.js';
import { openItemsLabel, topBarBindu } from '../../src/app/shell/TopBar.js';
import { ConnectionStore } from '../../src/host/connection-store.js';
import { cliDocument, readAnswer } from '../support/cli-documents.js';
import { FakeRpc, renderAt } from '../support/fake-rpc.js';
import { useFixedLayout } from '../support/layout.js';

useFixedLayout(1200, 600);

/** The app at `/` (Mission) over a host that answers the composer's reads. */
async function renderApp() {
  const rpc = new FakeRpc()
    .answer('read.mission_context', { home: '/home/u', platform: 'linux' })
    .answer('read.template.list', { schema: null, value: { items: [] }, next_cursor: null })
    .answer('read.effective_options', { path: ['ask'], mode: 'llm', options: [] });
  const { router } = await renderAt('/', rpc);
  return router;
}

describe('navigation', () => {
  it('shows four destinations, the command palette and Settings', async () => {
    await renderApp();

    const nav = screen.getByRole('navigation', { name: 'Main' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Mission',
      'Ledger',
      'Library',
      'Inbox',
    ]);
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('button', { name: 'Search or type a command' })).toBeTruthy();
  });

  it('links only to real pages, and every page is linked or opened from elsewhere', () => {
    const routes = Object.keys(makeRouter().routesByPath).filter((path) => path !== '/');

    expect(navigationPaths().filter((path) => !routes.includes(path))).toEqual([]);
    expect(
      routes.filter((path) => !navigationPaths().includes(path) && !UNLISTED_PATHS.includes(path)),
    ).toEqual([]);
  });

  it('places each page in its section', () => {
    expect(locate('/')?.section.id).toBe('mission');
    expect(locate('/mission/runs/r1')?.section.id).toBe('mission');
    expect(locate('/runs/r1/audit')?.section.id).toBe('ledger');
    expect(locate('/templates')?.section.id).toBe('library');
    expect(locate('/settings/credentials')?.group?.label).toBe('Setup');
    expect(locate('/health')?.group?.label).toBe('System');
    expect(locate('/onboarding')).toBeNull();
  });

  it('marks Library current on every Library tab, and the tab inside it', async () => {
    const rpc = new FakeRpc().answer(
      'read.template.list',
      readAnswer('TemplateListResult', cliDocument('template.list.action')),
    );
    await renderAt('/templates', rpc);

    const main = screen.getByRole('navigation', { name: 'Main' });
    expect(within(main).getByRole('link', { name: 'Library' }).getAttribute('aria-current')).toBe(
      'page',
    );
    const tabs = screen.getByRole('navigation', { name: 'Library' });
    expect(within(tabs).getByRole('link', { name: 'Templates' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      within(tabs).getByRole('link', { name: 'Workflows' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('frames a Settings page with the grouped menu and names its group', async () => {
    const rpc = new FakeRpc().answer(
      'read.config.path',
      readAnswer('ConfigPathResult', cliDocument('config.path.action')),
    );
    await renderAt('/settings/data', rpc);

    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe(
      'page',
    );
    const menu = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(menu).getAllByRole('list')).toHaveLength(3);
    expect(within(menu).getByText('System')).toBeTruthy();
    expect(within(menu).getByRole('link', { name: 'Data' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Data' })).toBeTruthy();
    expect(screen.getByText('Settings · Setup')).toBeTruthy();
  });

  it('shows the product name and an idle Bindu with its word', async () => {
    await renderApp();
    expect(screen.getByText('Yantra', { selector: 'span' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Yantra status: idle' })).toBeTruthy();
    expect(screen.getByText('Idle')).toBeTruthy();
  });
});

describe('connection banner', () => {
  it('is a polite live region that is always present', () => {
    const store = new ConnectionStore();
    store.set({ status: 'connected' });
    render(<ConnectionBanner store={store} />);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');
  });

  it('announces a disconnect with a countdown and the reconnect, without moving focus', () => {
    // Arrange: something on the page has focus.
    const store = new ConnectionStore();
    store.set({ status: 'connected' });
    render(
      <>
        <button type="button">Focused</button>
        <ConnectionBanner store={store} now={() => 10_000} />
      </>,
    );
    const button = screen.getByRole('button', { name: 'Focused' });
    button.focus();

    // Act
    act(() => {
      store.set({ status: 'disconnected', retryAt: 13_000 });
    });
    const during = screen.getByRole('status').textContent;
    act(() => {
      store.set({ status: 'connected' });
    });

    // Assert
    expect(during).toBe('Disconnected from Yantra. Reconnecting in 3 s.');
    expect(screen.getByRole('status').textContent).toBe('');
    expect(document.activeElement).toBe(button);
  });

  it.each([
    [{ status: 'connecting' } as const, 'Connecting to Yantra…'],
    [{ status: 'disconnected', retryAt: 0 } as const, 'Disconnected from Yantra. Reconnecting…'],
    [{ status: 'session_ended' } as const, 'Session ended — run `yantra ui` to reopen.'],
    [
      { status: 'incompatible', hostVersion: '2.0.0' } as const,
      'This window cannot talk to Yantra 2.0.0. Run `yantra ui` to reopen.',
    ],
  ])('words %j', (state, text) => {
    expect(connectionMessage(state, 1_000)).toBe(text);
  });
});

describe('session ended', () => {
  it('replaces the page with the yantra ui instruction', () => {
    const store = new ConnectionStore();
    store.set({ status: 'session_ended' });
    render(
      <AppShell store={store}>
        <p>page</p>
      </AppShell>,
    );
    expect(screen.getByRole('heading', { name: 'Session ended' })).toBeTruthy();
    expect(screen.getByText('yantra ui')).toBeTruthy();
    expect(screen.queryByText('page')).toBeNull();
  });

  it('names the running version when the host is incompatible', () => {
    const store = new ConnectionStore();
    store.set({ status: 'incompatible', hostVersion: '2.0.0' });
    render(
      <AppShell store={store}>
        <p>page</p>
      </AppShell>,
    );
    expect(screen.getByText('The running app is Yantra 2.0.0.')).toBeTruthy();
  });
});

describe('the Inbox in the top bar (REV-005)', () => {
  /** The app at `/` (Mission) with `count` open Inbox items. */
  async function renderWithInbox(count: () => number) {
    const rpc = new FakeRpc()
      .answer('read.mission_context', { home: '/home/u', platform: 'linux' })
      .answer('read.template.list', { schema: null, value: { items: [] }, next_cursor: null })
      .answer('read.effective_options', { path: ['ask'], mode: 'llm', options: [] })
      .answer('inbox.list', () => ({ items: [], count: count() }))
      .answer('attendance.heartbeat', {});
    await renderAt('/', rpc);
    return rpc;
  }

  it('badges the Inbox link and turns the Bindu Rani off the Inbox page', async () => {
    await renderWithInbox(() => 2);

    const nav = screen.getByRole('navigation', { name: 'Main' });
    const inbox = await within(nav).findByRole('link', { name: 'Inbox 2 items need you' });
    expect(inbox.querySelector('[data-inbox-badge]')?.textContent).toBe('2');
    const bindu = screen.getByRole('img', { name: 'Yantra status: 2 items need you' });
    expect(bindu.getAttribute('data-state')).toBe('attention');
  });

  it('shows no badge and an idle Bindu with nothing open', async () => {
    const rpc = await renderWithInbox(() => 0);

    await vi.waitFor(() => {
      expect(rpc.paramsOf('inbox.list').length).toBeGreaterThan(0);
    });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Inbox' })).toBeTruthy();
    expect(document.querySelector('[data-inbox-badge]')).toBeNull();
    expect(screen.getByRole('img', { name: 'Yantra status: idle' })).toBeTruthy();
  });

  it('updates the badge when an intervention event arrives', async () => {
    let open = 1;
    const rpc = await renderWithInbox(() => open);
    await screen.findByRole('link', { name: 'Inbox 1 item needs you' });

    open = 0;
    await act(async () => {
      rpc.notify('intervention.event', { run_id: 'r', seq: 2, event: {} });
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(document.querySelector('[data-inbox-badge]')).toBeNull();
    });
    expect(screen.getByRole('img', { name: 'Yantra status: idle' })).toBeTruthy();
  });

  it('subscribes the window to interventions on every page, so it attends (D5)', async () => {
    const rpc = await renderWithInbox(() => 0);
    expect(rpc.subscriptions).toContain('interventions.subscribe');
  });

  it('words one and several open items', () => {
    expect(openItemsLabel(1)).toBe('1 item needs you');
    expect(openItemsLabel(3)).toBe('3 items need you');
  });

  it('keeps the shell Bindu with nothing open and overrides it with open items', () => {
    const shell = { state: 'thinking' as const };
    expect(topBarBindu(shell, 0)).toBe(shell);
    expect(topBarBindu(shell, 1)).toEqual({
      state: 'attention',
      label: 'Yantra status: 1 item needs you',
    });
  });
});
