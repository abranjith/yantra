// @no-llm
/**
 * The app shell (FEAT-065 TASK-011): navigation from the registry, the
 * connection live region, and the session-ended view.
 */

import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NavRegistry, navRegistry } from '../../src/app/nav-registry.js';
import { AppShell } from '../../src/app/shell/AppShell.js';
import { ConnectionBanner, connectionMessage } from '../../src/app/shell/ConnectionBanner.js';
import { ConnectionStore } from '../../src/host/connection-store.js';
import { FakeRpc, renderAt } from '../support/fake-rpc.js';

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
  it('renders every registered route, including the generated surfaces', async () => {
    await renderApp();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(
      navRegistry.entries().map((entry) => entry.label),
    );
    const entries = navRegistry.entries();
    expect(entries).toContainEqual({ path: '/mission', label: 'Mission' });
    expect(entries).toContainEqual({ path: '/runs', label: 'Ledger' });
    expect(entries).toContainEqual({ path: '/settings/installation', label: 'Installation' });
    expect(entries).toContainEqual({ path: '/workflows', label: 'Workflows' });
    expect(entries).toContainEqual({ path: '/daemon', label: 'Daemon' });
    expect(entries).toContainEqual({ path: '/inbox', label: 'Inbox' });
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
  });

  it('refuses to register one path twice', () => {
    const registry = new NavRegistry();
    registry.register({ path: '/runs', label: 'Runs' });
    expect(() => {
      registry.register({ path: '/runs', label: 'Again' });
    }).toThrow(/already registered/u);
  });

  it('shows the product name and an idle Bindu', async () => {
    await renderApp();
    expect(screen.getByText('Yantra', { selector: 'span' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Yantra status: idle' })).toBeTruthy();
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
      <AppShell store={store} nav={new NavRegistry()}>
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
      <AppShell store={store} nav={new NavRegistry()}>
        <p>page</p>
      </AppShell>,
    );
    expect(screen.getByText('The running app is Yantra 2.0.0.')).toBeTruthy();
  });
});
