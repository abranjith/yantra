import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { DOCTOR_CHECK_IDS, type DoctorResult } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { RpcProvider } from '../../../src/host/app-rpc.js';
import { HealthSurface } from '../../../src/surfaces/health/health-route.js';
import { expectNoAxeViolations } from '../../support/axe.js';
import { FakeRpc } from '../../support/fake-rpc.js';

function allKnownChecksResult(): DoctorResult {
  return {
    checks: DOCTOR_CHECK_IDS.map((id, index) => ({
      id,
      title: `Title for ${id}`,
      status: index === 0 ? 'ok' : index === 1 ? 'warn' : 'ok',
      summary: `Summary for ${id}`,
      ...(index === 1 ? { remediation: `Fix hint for ${id}` } : {}),
    })),
    overall: 'warn',
    version: '0.0.1',
    platform: 'linux',
    nodeVersion: 'v24.15.0',
    browser: {
      source: 'auto',
      origin: 'default',
      ownership: 'managed',
      executablePath: '/home/user/.yantra/browsers/chrome',
      browserVersion: '130.0.0.0',
      compatibility: 'tested',
      managedRoot: '/home/user/.yantra/browsers',
      managedBuild: '130.0.6723.91',
      orphanCount: 1,
      reclaimableBytes: 2_048,
      alternatives: [],
    },
    search: {
      provider: 'tavily',
      kind: 'api',
      via: 'config',
    },
  };
}

function renderHealth(result: DoctorResult) {
  const rpc = new FakeRpc();
  rpc.answer('read.doctor', result);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const view = render(
    <QueryClientProvider client={queryClient}>
      <RpcProvider rpc={rpc}>
        <HealthSurface />
      </RpcProvider>
    </QueryClientProvider>,
  );

  return { ...view, rpc, queryClient };
}

describe('@no-llm HealthSurface', () => {
  it('renders a row for every DoctorCheckId plus browser and search provenance', async () => {
    const { container } = renderHealth(allKnownChecksResult());

    await waitFor(() => {
      expect(screen.getByTestId('health-overall').textContent).toBe('warn');
    });

    for (const id of DOCTOR_CHECK_IDS) {
      expect(screen.getByText(`Title for ${id}`)).toBeTruthy();
      expect(container.querySelector(`[data-check-id="${id}"]`)).toBeTruthy();
    }

    expect(screen.getByText('Browser provenance')).toBeTruthy();
    expect(screen.getByText('130.0.0.0')).toBeTruthy();
    expect(screen.getByText('Search provenance')).toBeTruthy();
    expect(screen.getByText('tavily')).toBeTruthy();
  });

  it('renders an unknown check ID generically with its title from the payload', async () => {
    const result: DoctorResult = {
      checks: [
        {
          id: 'future.subsystem.check',
          title: 'Future subsystem ready',
          status: 'fail',
          summary: 'Future subsystem is missing.',
          remediation: 'Install future subsystem.',
        },
      ],
      overall: 'fail',
      version: '0.0.1',
      platform: 'linux',
      nodeVersion: 'v24.15.0',
    };

    const { container } = renderHealth(result);

    await waitFor(() => {
      expect(screen.getByText('Future subsystem ready')).toBeTruthy();
    });
    expect(container.querySelector('[data-check-id="future.subsystem.check"]')).toBeTruthy();
    expect(screen.getByText('Install future subsystem.')).toBeTruthy();
  });

  it('sends refresh: true when Re-run checks is pressed', async () => {
    const user = userEvent.setup();
    const { rpc } = renderHealth(allKnownChecksResult());

    await waitFor(() => {
      expect(screen.getByTestId('health-overall')).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: 'Re-run checks' }));

    await waitFor(() => {
      const doctorCalls = rpc.calls.filter((call) => call.method === 'read.doctor');
      expect(
        doctorCalls.some((call) => (call.params as { refresh?: boolean }).refresh === true),
      ).toBe(true);
    });
  });

  it('has no axe violations', async () => {
    const { container } = renderHealth(allKnownChecksResult());

    await waitFor(() => {
      expect(screen.getByTestId('health-overall')).toBeTruthy();
    });

    await expectNoAxeViolations(container);
  });
});
