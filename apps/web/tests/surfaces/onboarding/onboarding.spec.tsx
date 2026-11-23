import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { OnboardingResult, OnboardingStatus } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeRouter } from '../../../src/app/router.js';
import { AppToasts } from '../../../src/app/shell/toasts.js';
import { RpcProvider } from '../../../src/host/app-rpc.js';
import { RpcCallError } from '../../../src/host/rpc-client.js';
import { resetOnboardingDismissal } from '../../../src/surfaces/onboarding/session-dismissal.js';
import { expectNoAxeViolations } from '../../support/axe.js';
import { cliDocument, readAnswer } from '../../support/cli-documents.js';
import { FakeRpc } from '../../support/fake-rpc.js';
import {
  installIntersectionObserver,
  resetIntersectionObservers,
} from '../../support/intersection-observer.js';

const CANARY_CRED = 'CANARY_ONBOARD_CRED_9911';
const CANARY_SEARCH = 'CANARY_ONBOARD_SEARCH_8822';

function makeStatus(overrides: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return {
    config_exists: false,
    profile_exists: false,
    config_path: '/tmp/yantra/config.yaml',
    profile_path: '/tmp/yantra/profile.yaml',
    data_dir: {
      effective: '/tmp/yantra/data',
      source: 'default',
      configured: null,
    },
    keychain_available: true,
    ...overrides,
  };
}

function makeSuccessResult(overrides: Partial<OnboardingResult> = {}): OnboardingResult {
  return {
    status: 'written',
    config_path: '/tmp/yantra/config.yaml',
    profile_path: '/tmp/yantra/profile.yaml',
    profile_written: true,
    provider: 'anthropic',
    search_key: 'stored',
    location_shared: false,
    ...overrides,
  };
}

function renderOnboardingRoute(
  initialPath = '/onboarding',
  statusOverrides: Partial<OnboardingStatus> = {},
) {
  const rpc = new FakeRpc();
  rpc.answer('read.onboarding_status', makeStatus(statusOverrides));
  rpc.answer('read.mission.context', {
    home: '/tmp/yantra',
    providers: [],
    defaults: { provider: 'none', model: null, thinking: null },
  });
  rpc.answer('onboarding.submit', makeSuccessResult());

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const history = createMemoryHistory({ initialEntries: [initialPath] });
  const router = makeRouter(history);

  const view = render(
    <QueryClientProvider client={queryClient}>
      <RpcProvider rpc={rpc}>
        <AppToasts>
          <RouterProvider router={router} />
        </AppToasts>
      </RpcProvider>
    </QueryClientProvider>,
  );

  return { ...view, rpc, queryClient, router, history };
}

describe('@no-llm OnboardingSurface', () => {
  beforeEach(() => {
    installIntersectionObserver();
    resetOnboardingDismissal();
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    resetIntersectionObservers();
    resetOnboardingDismissal();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('has no pre-selected answers, makes no env RPC calls, and disables Next until applicable questions are answered', async () => {
    const user = userEvent.setup();
    const { rpc, container } = renderOnboardingRoute('/onboarding');

    expect(await screen.findByRole('heading', { name: 'Model' })).toBeDefined();

    // No radio option is checked initially
    const radios = screen.getAllByRole<HTMLInputElement>('radio');
    expect(radios.every((r) => !r.checked)).toBe(true);

    // Next is disabled until provider is explicitly selected
    const nextBtn = screen.getByRole<HTMLButtonElement>('button', { name: 'Next' });
    expect(nextBtn.disabled).toBe(true);

    // No env-related RPC call is ever issued
    expect(rpc.calls.every((c) => !c.method.toLowerCase().includes('env'))).toBe(true);
    await expectNoAxeViolations(container);

    // Selecting provider 'none' hides credential and model questions and enables Next
    await user.click(screen.getByRole('radio', { name: 'none' }));
    expect(screen.queryByText('Credential source')).toBeNull();
    expect(screen.queryByText('Model id')).toBeNull();
    expect(nextBtn.disabled).toBe(false);
  });

  it('disables keychain choice with inline remedy when keychain_available is false', async () => {
    const user = userEvent.setup();
    renderOnboardingRoute('/onboarding', { keychain_available: false });

    expect(await screen.findByRole('heading', { name: 'Model' })).toBeDefined();
    await user.click(screen.getByRole('radio', { name: 'anthropic' }));

    const keychainRadio = screen.getByRole<HTMLInputElement>('radio', { name: /keychain/u });
    expect(keychainRadio.disabled).toBe(true);
    expect(screen.getByText(/OS keychain is unavailable/u)).toBeDefined();
  });

  it('Not now issues no onboarding.submit and shows the non-modal SetupBanner on Mission', async () => {
    const user = userEvent.setup();
    const { rpc, history } = renderOnboardingRoute('/onboarding');

    expect(await screen.findByRole('heading', { name: 'Model' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Not now' }));

    await waitFor(() => {
      expect(history.location.pathname).toBe('/mission');
    });
    expect(rpc.calls.some((c) => c.method === 'onboarding.submit')).toBe(false);
    expect(await screen.findByText("Yantra isn't set up yet")).toBeDefined();
    expect(screen.getByRole('link', { name: 'Set up' })).toBeDefined();
  });

  it('redirects to /onboarding on load when config_exists is false', async () => {
    const { history } = renderOnboardingRoute('/mission');

    await waitFor(() => {
      expect(history.location.pathname).toBe('/onboarding');
    });
    expect(await screen.findByRole('heading', { name: 'Model' })).toBeDefined();
  });

  it('submits InitAnswers with secrets only in secrets, keeps canary out of DOM/cache/storage, and is axe-clean on every step', async () => {
    const user = userEvent.setup();
    const { rpc, queryClient, container } = renderOnboardingRoute('/onboarding');

    // Step 1: Model
    expect(await screen.findByRole('heading', { name: 'Model' })).toBeDefined();
    await user.click(screen.getByRole('radio', { name: 'anthropic' }));
    await user.click(screen.getByRole('radio', { name: 'keychain' }));
    await user.type(screen.getByLabelText(/Secret value for anthropic\.api_key/u), CANARY_CRED);
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Step 2: Search
    expect(await screen.findByRole('heading', { name: 'Search' })).toBeDefined();
    await user.click(screen.getByRole('radio', { name: 'tavily' }));
    await user.type(screen.getByLabelText(/Secret value for tavily\.api_key/u), CANARY_SEARCH);
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Step 3: Storage (read-only DEVIATION-1)
    expect(await screen.findByRole('heading', { name: 'Storage' })).toBeDefined();
    expect(screen.getByText('/tmp/yantra/data')).toBeDefined();
    expect(screen.getByText(/yantra config data-dir/u)).toBeDefined();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Step 4: Context
    expect(await screen.findByRole('heading', { name: 'Context' })).toBeDefined();
    const contextNext = screen.getByRole<HTMLButtonElement>('button', { name: 'Next' });
    expect(contextNext.disabled).toBe(true);
    await user.click(screen.getByRole('radio', { name: 'No' }));
    expect(screen.queryByLabelText(/City or area/u)).toBeNull();
    expect(contextNext.disabled).toBe(false);
    await expectNoAxeViolations(container);
    await user.click(contextNext);

    // Step 5: Review
    expect(await screen.findByRole('heading', { name: 'Review' })).toBeDefined();
    expect(
      screen.getByText('Will be stored in the OS keychain as anthropic.api_key'),
    ).toBeDefined();
    expect(screen.getByText('Will be stored in the OS keychain as tavily.api_key')).toBeDefined();
    expect(container.querySelectorAll('[data-part="protected-value"]')).toHaveLength(2);
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Setup complete' })).toBeDefined();
    });
    await expectNoAxeViolations(container);

    const submitCall = rpc.calls.find((c) => c.method === 'onboarding.submit');
    expect(submitCall).toBeDefined();
    expect(submitCall!.params.answers).toEqual({
      provider: 'anthropic',
      credential_source: 'keychain',
      model_id: 'claude-opus-4-7',
      search_key_provider: 'tavily',
      data_dir: null,
      context_location: false,
    });
    expect(submitCall!.params.secrets).toEqual({
      credential_secret: CANARY_CRED,
      search_key_secret: CANARY_SEARCH,
    });
    expect(typeof submitCall!.params.invocation_id).toBe('string');

    // Canary must not appear in DOM, query/mutation cache, or web storage
    expect(document.body.innerHTML).not.toContain(CANARY_CRED);
    expect(document.body.innerHTML).not.toContain(CANARY_SEARCH);
    const cacheText = JSON.stringify(queryClient.getQueryCache().getAll());
    const mutationText = JSON.stringify(queryClient.getMutationCache().getAll());
    expect(cacheText).not.toContain(CANARY_CRED);
    expect(cacheText).not.toContain(CANARY_SEARCH);
    expect(mutationText).not.toContain(CANARY_CRED);
    expect(mutationText).not.toContain(CANARY_SEARCH);
    expect(JSON.stringify(sessionStorage)).not.toContain(CANARY_CRED);
    expect(JSON.stringify(localStorage)).not.toContain(CANARY_CRED);
  });

  it('supports keyboard-only completion of the onboarding flow', async () => {
    const user = userEvent.setup();
    const { rpc } = renderOnboardingRoute('/onboarding');

    expect(await screen.findByRole('heading', { name: 'Model' })).toBeDefined();

    // Select 'none' via keyboard (focus radio, arrow down to 'none')
    const anthropicRadio = screen.getByRole('radio', { name: 'anthropic' });
    anthropicRadio.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'none' }).checked).toBe(true);

    // Tab to Next and press Enter
    await user.tab();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Search' })).toBeDefined();

    // Select 'skip' via keyboard
    const tavilyRadio = screen.getByRole('radio', { name: 'tavily' });
    tavilyRadio.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    // Tab past Back to Next
    await user.tab();
    await user.tab();
    await user.keyboard('{Enter}');

    // Storage step
    expect(await screen.findByRole('heading', { name: 'Storage' })).toBeDefined();
    const storageNext = screen.getByRole('button', { name: 'Next' });
    storageNext.focus();
    await user.keyboard('{Enter}');

    // Context step: pick No
    expect(await screen.findByRole('heading', { name: 'Context' })).toBeDefined();
    const yesRadio = screen.getByRole('radio', { name: 'Yes' });
    yesRadio.focus();
    await user.keyboard('{ArrowDown}');
    await user.tab();
    await user.tab();
    await user.keyboard('{Enter}');

    // Review step: submit via keyboard
    expect(await screen.findByRole('heading', { name: 'Review' })).toBeDefined();
    const finishBtn = screen.getByRole('button', { name: 'Finish setup' });
    finishBtn.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(rpc.calls.some((c) => c.method === 'onboarding.submit')).toBe(true);
    });
  });

  it('renders error states for already_initialized, relocation_requires_terminal, busy, and keychain_unavailable', async () => {
    const user = userEvent.setup();

    async function walkToReview(rpc: FakeRpc) {
      expect(await screen.findByRole('heading', { name: 'Model' })).toBeDefined();
      await user.click(screen.getByRole('radio', { name: 'none' }));
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await user.click(screen.getByRole('radio', { name: 'skip' }));
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await user.click(screen.getByRole('radio', { name: 'No' }));
      await user.click(screen.getByRole('button', { name: 'Next' }));
      expect(await screen.findByRole('heading', { name: 'Review' })).toBeDefined();
      expect(rpc).toBeDefined();
    }

    // 1. already_initialized
    {
      const { rpc, unmount } = renderOnboardingRoute('/onboarding');
      rpc.answer('onboarding.submit', () => {
        throw new RpcCallError(
          'onboarding.submit',
          -32000,
          'Yantra is already initialized.',
          'already_initialized',
          'Pass reset: true.',
        );
      });
      await walkToReview(rpc);
      await user.click(screen.getByRole('button', { name: 'Finish setup' }));
      expect(await screen.findByText('Yantra is already initialized.')).toBeDefined();
      expect(screen.getByRole('button', { name: 'Run setup with reset' })).toBeDefined();
      unmount();
    }

    // 2. relocation_requires_terminal
    {
      const { rpc, unmount } = renderOnboardingRoute('/onboarding');
      rpc.answer('onboarding.submit', () => {
        throw new RpcCallError(
          'onboarding.submit',
          -32000,
          'Changing the data directory requires restarting Yantra from a terminal.',
          'relocation_requires_terminal',
          undefined,
        );
      });
      await walkToReview(rpc);
      await user.click(screen.getByRole('button', { name: 'Finish setup' }));
      const alert = await screen.findByRole('alert');
      expect(
        within(alert).getByText(
          'Changing the data directory requires restarting Yantra from a terminal.',
        ),
      ).toBeDefined();
      expect(within(alert).getByText('Close every Yantra window')).toBeDefined();
      unmount();
    }

    // 3. busy
    {
      const { rpc, unmount } = renderOnboardingRoute('/onboarding');
      rpc.answer('onboarding.submit', () => {
        throw new RpcCallError(
          'onboarding.submit',
          -32000,
          'Config lock held by PID 4242.',
          'busy',
          'Wait for the other command to finish.',
        );
      });
      await walkToReview(rpc);
      await user.click(screen.getByRole('button', { name: 'Finish setup' }));
      expect(await screen.findByText('Config lock held by PID 4242.')).toBeDefined();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
      unmount();
    }

    // 4. keychain_unavailable returns to Model step with remedy
    {
      const { rpc, unmount } = renderOnboardingRoute('/onboarding');
      rpc.answer('onboarding.submit', () => {
        throw new RpcCallError(
          'onboarding.submit',
          -32000,
          'OS keychain is unavailable.',
          'keychain_unavailable',
          'Unlock your login keychain.',
        );
      });
      await walkToReview(rpc);
      await user.click(screen.getByRole('button', { name: 'Finish setup' }));
      expect(await screen.findByRole('heading', { name: 'Model' })).toBeDefined();
      expect(screen.getByText('Unlock your login keychain.')).toBeDefined();
      unmount();
    }
  });

  it('InstallationResetTrigger requires explicit confirmation before navigating to /onboarding?reset=1', async () => {
    const user = userEvent.setup();
    const rpc = new FakeRpc();
    rpc.answer('read.onboarding_status', makeStatus({ config_exists: true }));
    rpc.answer(
      'read.config.list',
      readAnswer('ConfigListResult', cliDocument('config.list.action')),
    );
    rpc.answer(
      'read.config.path',
      readAnswer('ConfigPathResult', cliDocument('config.path.action')),
    );
    rpc.answer(
      'read.config.validate',
      readAnswer('ConfigValidateResult', cliDocument('config.validate.action')),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const history = createMemoryHistory({ initialEntries: ['/settings/installation'] });
    const router = makeRouter(history);

    render(
      <QueryClientProvider client={queryClient}>
        <RpcProvider rpc={rpc}>
          <AppToasts>
            <RouterProvider router={router} />
          </AppToasts>
        </RpcProvider>
      </QueryClientProvider>,
    );

    const runAgainBtn = await screen.findByRole('button', { name: 'Run setup again' });
    await user.click(runAgainBtn);
    const dialog = await screen.findByRole('alertdialog');
    const continueBtn = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Continue to setup',
    });
    expect(continueBtn.disabled).toBe(true);

    await user.click(within(dialog).getByRole('checkbox'));
    expect(continueBtn.disabled).toBe(false);
    await user.click(continueBtn);

    await waitFor(() => {
      expect(history.location.pathname).toBe('/onboarding');
      expect(history.location.search).toContain('reset=true');
    });
    expect(await screen.findByText(/Reset mode:/u)).toBeDefined();
  });
});
