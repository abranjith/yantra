import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { DoctorResult, HostEnvironmentInfo, PossibleOrphansResult } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import { RpcProvider } from '../../../src/host/app-rpc.js';
import { HostEnvironmentPanel } from '../../../src/surfaces/health/host-environment.js';
import { expectNoAxeViolations } from '../../support/axe.js';
import { FakeRpc, renderAt } from '../../support/fake-rpc.js';

function minimalDoctorResult(): DoctorResult {
  return {
    checks: [
      {
        id: 'config.valid',
        title: 'Configuration schema valid',
        status: 'ok',
        summary: 'Configuration is schema-valid.',
      },
    ],
    overall: 'ok',
    version: '0.0.1',
    platform: 'linux',
    nodeVersion: 'v24.15.0',
  };
}

describe('@no-llm Health HostEnvironmentPanel & PossibleOrphansPanel', () => {
  it('renders host environment age with a stepped clock and D13 restart instructions', async () => {
    vi.useFakeTimers();
    try {
      const startMs = Date.parse('2026-11-19T10:00:00.000Z');
      vi.setSystemTime(startMs + 5 * 60_000);

      const hostInfo: HostEnvironmentInfo = {
        host_started_at: '2026-11-19T10:00:00.000Z',
        env_captured_at: '2026-11-19T10:00:00.000Z',
        yantra_version: '0.2.0',
        host_pid: 9876,
      };

      const rpc = new FakeRpc().answer('read.host_status', hostInfo);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { container } = render(
        <QueryClientProvider client={queryClient}>
          <RpcProvider rpc={rpc}>
            <HostEnvironmentPanel />
          </RpcProvider>
        </QueryClientProvider>,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText('App host')).toBeTruthy();
      expect(screen.getByTestId('host-env-captured').textContent).toContain(
        'Environment captured 5 minutes ago (at 2026-11-19T10:00:00.000Z)',
      );
      expect(screen.getByText(/Runs started from the app use the environment/i)).toBeTruthy();
      expect(screen.getByTestId('host-yantra-version').textContent).toBe('0.2.0');
      expect(screen.getByTestId('host-pid').textContent).toBe('9876');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(screen.getByTestId('host-env-captured').textContent).toContain(
        'Environment captured 6 minutes ago',
      );
      expect(container.querySelectorAll('button')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders possible orphans with no destructive control and re-reads on Check again', async () => {
    const user = userEvent.setup();
    const orphansResult: PossibleOrphansResult = {
      orphans: [
        {
          run_id: 'run-orphan-42',
          pid: 4321,
          recorded_start_token_present: false,
          executable: 'chrome.exe',
          recorded_at: '2026-11-19T10:05:00.000Z',
          reason: 'identity_unverifiable',
        },
      ],
    };

    const rpc = new FakeRpc()
      .answer('read.doctor', minimalDoctorResult())
      .answer('read.host_status', {
        host_started_at: '2026-11-19T10:00:00.000Z',
        env_captured_at: '2026-11-19T10:00:00.000Z',
        yantra_version: '0.2.0',
        host_pid: 9876,
      })
      .answer('read.possible_orphans', orphansResult);

    const { container } = await renderAt('/health', rpc);

    await waitFor(() => {
      expect(screen.getByTestId('health-possible-orphans')).toBeTruthy();
    });

    const block = screen.getByTestId('health-possible-orphans');
    expect(block.textContent).toContain(
      'Yantra could not confirm this process belongs to the run, so it was not stopped.',
    );
    expect(screen.getByRole('link', { name: 'run-orphan-42' })).toBeTruthy();
    expect(block.textContent).toContain('4321');
    expect(block.textContent).toContain('chrome.exe');
    expect(block.textContent).toContain('2026-11-19T10:05:00.000Z');

    // No destructive control (kill/stop/terminate/remove) inside the Possible orphans block.
    const buttons = [...block.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Check again']);

    const initialCalls = rpc.calls.filter((c) => c.method === 'read.possible_orphans').length;
    await user.click(screen.getByRole('button', { name: 'Check again' }));

    await waitFor(() => {
      expect(rpc.calls.filter((c) => c.method === 'read.possible_orphans').length).toBeGreaterThan(
        initialCalls,
      );
    });

    await expectNoAxeViolations(container);
  });

  it('hides the Possible orphans block when the list is empty', async () => {
    const rpc = new FakeRpc()
      .answer('read.doctor', minimalDoctorResult())
      .answer('read.possible_orphans', { orphans: [] });

    await renderAt('/health', rpc);

    await waitFor(() => {
      expect(screen.getByTestId('health-overall')).toBeTruthy();
    });

    expect(screen.queryByTestId('health-possible-orphans')).toBeNull();
  });
});
