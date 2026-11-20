import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { DOCTOR_CHECK_IDS, type DoctorResult, type InvocationSummary } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../support/axe.js';
import { FakeRpc, renderAt } from '../../support/fake-rpc.js';

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

function finishedSummary(path: readonly string[]): InvocationSummary {
  return {
    invocation_id: 'inv_0123456789abcdef',
    state: 'finished',
    execution_class: 'run',
    path: [...path],
    run_id: null,
    queued_at: '2026-11-19T00:00:00Z',
    review: null,
    result: { exit_code: 0, finished_at: '2026-11-19T00:00:01Z' },
  };
}

describe('@no-llm HealthSurface', () => {
  it('renders a row for every DoctorCheckId plus browser and search provenance', async () => {
    const rpc = new FakeRpc().answer('read.doctor', allKnownChecksResult());
    const { container } = await renderAt('/health', rpc);

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

    const rpc = new FakeRpc().answer('read.doctor', result);
    const { container } = await renderAt('/health', rpc);

    await waitFor(() => {
      expect(screen.getByText('Future subsystem ready')).toBeTruthy();
    });
    expect(container.querySelector('[data-check-id="future.subsystem.check"]')).toBeTruthy();
    expect(screen.getByText('Install future subsystem.')).toBeTruthy();
  });

  it('sends refresh: true when Re-run checks is pressed', async () => {
    const user = userEvent.setup();
    const rpc = new FakeRpc().answer('read.doctor', allKnownChecksResult());
    await renderAt('/health', rpc);

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

  it('invokes browser check remediation and refreshes doctor on completion', async () => {
    const user = userEvent.setup();
    const result: DoctorResult = {
      checks: [
        {
          id: 'browser.compatibility',
          title: 'Browser passes required capabilities',
          status: 'warn',
          summary: 'This browser has not been checked on this machine yet.',
          details: { compatibility: 'unverified', path: '/usr/bin/chrome' },
          remediation: 'Run `yantra browser check` to test it locally.',
        },
      ],
      overall: 'warn',
      version: '0.0.1',
      platform: 'linux',
      nodeVersion: 'v24.15.0',
    };

    const rpc = new FakeRpc()
      .answer('read.doctor', result)
      .answer('command.invoke', finishedSummary(['browser', 'check']));

    await renderAt('/health', rpc);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run browser check' })).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: 'Run browser check' }));

    await waitFor(() => {
      const invokeCalls = rpc.paramsOf('command.invoke');
      expect(invokeCalls).toHaveLength(1);
      const invocation = invokeCalls[0]?.invocation as { path: string[]; argv: string[] };
      expect(invocation.path).toEqual(['browser', 'check']);
      expect(invocation.argv).toEqual([]);

      const doctorCalls = rpc.paramsOf('read.doctor');
      expect(doctorCalls.some((params) => params.refresh === true)).toBe(true);
    });
  });

  it('navigates from search key remediation to Credentials with key prefilled', async () => {
    const user = userEvent.setup();
    const result: DoctorResult = {
      checks: [
        {
          id: 'search.tavily.api-key',
          title: 'Tavily API key',
          status: 'warn',
          summary: 'No tavily API key is available.',
          details: { source: 'absent' },
          remediation: 'Run `yantra secret set tavily.api_key`.',
        },
      ],
      overall: 'warn',
      version: '0.0.1',
      platform: 'linux',
      nodeVersion: 'v24.15.0',
    };

    const rpc = new FakeRpc()
      .answer('read.doctor', result)
      .answer('secret.list', { available: true, remedy: null, rows: [] });

    const { router } = await renderAt('/health', rpc);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add Tavily key' })).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: 'Add Tavily key' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/credentials');
      expect((router.state.location.search as { key?: string }).key).toBe('tavily.api_key');
    });
  });

  it('has no axe violations', async () => {
    const rpc = new FakeRpc().answer('read.doctor', allKnownChecksResult());
    const { container } = await renderAt('/health', rpc);

    await waitFor(() => {
      expect(screen.getByTestId('health-overall')).toBeTruthy();
    });

    await expectNoAxeViolations(container);
  });
});
