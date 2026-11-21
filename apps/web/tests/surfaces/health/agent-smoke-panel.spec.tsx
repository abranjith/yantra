import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type {
  DoctorResult,
  EffectiveOptions,
  InvocationSummary,
  ProviderReadiness,
} from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../support/axe.js';
import { FakeRpc, renderAt } from '../../support/fake-rpc.js';

function minimalDoctorResult(): DoctorResult {
  return {
    checks: [
      {
        id: 'agent.model',
        title: 'Agent model configuration',
        status: 'ok',
        summary: 'anthropic/claude-haiku-4-5',
      },
    ],
    overall: 'ok',
    version: '0.0.1',
    platform: 'linux',
    nodeVersion: 'v24.15.0',
  };
}

function readyEffectiveOptions(mode: 'llm' | 'deterministic' = 'llm'): EffectiveOptions {
  return {
    path: ['doctor'],
    mode,
    options: [
      { option: 'provider', flag: '--provider', value: 'anthropic', source: { kind: 'default' } },
      {
        option: 'model',
        flag: '--model',
        value: 'claude-haiku-4-5',
        source: { kind: 'default' },
      },
      { option: 'thinking', flag: '--thinking', value: null, source: { kind: 'default' } },
      {
        option: 'authSecret',
        flag: '--auth-secret',
        value: null,
        source: { kind: 'default' },
      },
    ],
  };
}

function readyProvider(): ProviderReadiness {
  return { ready: true, provider: 'anthropic', model: 'claude-haiku-4-5' };
}

function baseRpc(
  effective: EffectiveOptions = readyEffectiveOptions(),
  readiness: ProviderReadiness = readyProvider(),
): FakeRpc {
  return new FakeRpc()
    .answer('read.doctor', minimalDoctorResult())
    .answer('read.mission_context', { home: '/home/user', platform: 'linux' })
    .answer('read.effective_options', effective)
    .answer('read.provider_readiness', readiness);
}

function runningSummary(
  invocationId = 'inv_0123456789abcdef',
  state: InvocationSummary['state'] = 'queued',
  runId: string | null = null,
): InvocationSummary {
  return {
    invocation_id: invocationId,
    state,
    execution_class: 'run',
    path: ['doctor'],
    run_id: runId,
    queued_at: '2026-11-19T00:00:00Z',
    review: null,
    result: null,
  };
}

describe('@no-llm AgentSmokePanel', () => {
  it('renders registry model-selection options and invokes doctor --agent-smoke with user overrides', async () => {
    const user = userEvent.setup();
    const rpc = baseRpc().answer('command.invoke', (params) => {
      const inv = params.invocation as { invocation_id: string };
      return runningSummary(inv.invocation_id, 'queued');
    });

    await renderAt('/health', rpc);

    await waitFor(() => {
      expect(screen.getByTestId('agent-smoke-panel')).toBeTruthy();
      expect(screen.getByLabelText('Provider')).toBeTruthy();
    });

    await user.type(screen.getByLabelText('Provider'), 'ollama');
    await user.type(screen.getByLabelText('Model'), 'llama3.1:8b');
    await user.click(screen.getByRole('button', { name: 'Run smoke test' }));

    await waitFor(() => {
      const invokes = rpc.paramsOf('command.invoke');
      expect(invokes).toHaveLength(1);
      const invocation = invokes[0]?.invocation as {
        path: string[];
        argv: string[];
        cwd: string;
      };
      expect(invocation.path).toEqual(['doctor']);
      expect(invocation.argv).toEqual([
        '--agent-smoke',
        '--provider',
        'ollama',
        '--model',
        'llama3.1:8b',
      ]);
      expect(invocation.cwd).toBe('/home/user');
    });
  });

  it('disables the button with CLI reason and Settings -> Models link when LLM_PROVIDER=none', async () => {
    const rpc = baseRpc(readyEffectiveOptions('deterministic'), {
      ready: false,
      provider: '',
      model: '',
      reason: 'The model is turned off on this computer (LLM_PROVIDER=none).',
    });

    await renderAt('/health', rpc);

    await waitFor(() => {
      expect(screen.getByTestId('smoke-unavailable')).toBeTruthy();
    });

    const button = screen.getByRole('button', { name: 'Run smoke test' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('smoke-unavailable').textContent).toContain(
      '`doctor --agent-smoke` requires an LLM; unset LLM_PROVIDER=none.',
    );
    const link = screen.getByRole('link', { name: 'Settings → Models' });
    expect(link.getAttribute('href')).toBe('/settings/models');
  });

  it('disables the button with reason and Settings -> Models link when no provider credential is configured', async () => {
    const rpc = baseRpc(readyEffectiveOptions('llm'), {
      ready: false,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      reason: 'No credential for anthropic is set up on this computer.',
    });

    await renderAt('/health', rpc);

    await waitFor(() => {
      expect(screen.getByTestId('smoke-unavailable')).toBeTruthy();
    });

    const button = screen.getByRole('button', { name: 'Run smoke test' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('smoke-unavailable').textContent).toContain(
      'No credential for anthropic is set up on this computer.',
    );
    expect(screen.getByRole('link', { name: 'Settings → Models' })).toBeTruthy();
  });

  it.each(['passed', 'failed', 'aborted'] as const)(
    'renders the %s doctor_smoke envelope and links to /runs/<runId>',
    async (outcomeValue) => {
      const user = userEvent.setup();
      let capturedId = '';
      const rpc = baseRpc()
        .answer('command.invoke', (params) => {
          const inv = params.invocation as { invocation_id: string };
          capturedId = inv.invocation_id;
          return runningSummary(capturedId, 'queued');
        })
        .answer('read.invocation', () => runningSummary(capturedId, 'finished', 'agent-smoke-123'));

      await renderAt('/health', rpc);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Run smoke test' })).toBeTruthy();
      });

      await user.click(screen.getByRole('button', { name: 'Run smoke test' }));

      await waitFor(() => {
        expect(capturedId).not.toBe('');
      });

      act(() => {
        rpc.notify('invocation.result', {
          invocation_id: capturedId,
          outcome: {
            type: 'result',
            exit_code: outcomeValue === 'passed' ? 0 : outcomeValue === 'aborted' ? 130 : 3,
            envelope: {
              schemaVersion: 1,
              kind: 'doctor_smoke',
              outcome: outcomeValue,
              provider: 'ollama',
              model: 'llama3.1:8b',
              runId: 'agent-smoke-123',
              statusToolInvoked: outcomeValue === 'passed',
              usage: { turns: 2, inputTokens: 100, outputTokens: 25, costUsd: 0.0012 },
            },
            text: null,
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('smoke-outcome').textContent).toBe(outcomeValue);
      });

      const resultEl = screen.getByTestId('smoke-result');
      expect(resultEl.textContent).toContain('ollama/llama3.1:8b');
      expect(resultEl.textContent).toContain('2');
      expect(resultEl.textContent).toContain('100 in / 25 out');
      expect(resultEl.textContent).toContain(String(outcomeValue === 'passed'));

      const runLink = screen.getByRole('link', { name: 'Open run' });
      expect(runLink.getAttribute('href')).toBe('/runs/agent-smoke-123');
    },
  );

  it('renders AGENT_AUTH_UNAVAILABLE error envelope with code, remediation, and exit 3 as environment', async () => {
    const user = userEvent.setup();
    let capturedId = '';
    const rpc = baseRpc()
      .answer('command.invoke', (params) => {
        const inv = params.invocation as { invocation_id: string };
        capturedId = inv.invocation_id;
        return runningSummary(capturedId, 'spawning');
      })
      .answer('read.invocation', () => runningSummary(capturedId, 'finished', null));

    await renderAt('/health', rpc);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run smoke test' })).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: 'Run smoke test' }));

    await waitFor(() => {
      expect(capturedId).not.toBe('');
    });

    act(() => {
      rpc.notify('invocation.result', {
        invocation_id: capturedId,
        outcome: {
          type: 'error',
          exit_code: 3,
          code: 'AGENT_AUTH_UNAVAILABLE',
          message: 'No credential found for anthropic.',
          remediation: 'Set the provider API key, seed managed auth, or pass --auth-secret <ref>.',
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('smoke-error-result')).toBeTruthy();
    });

    const errBox = screen.getByTestId('smoke-error-result');
    expect(errBox.textContent).toContain('AGENT_AUTH_UNAVAILABLE');
    expect(errBox.textContent).toContain('environment');
    expect(errBox.textContent).toContain('No credential found for anthropic.');
    expect(errBox.textContent).toContain(
      'Set the provider API key, seed managed auth, or pass --auth-secret <ref>.',
    );
  });

  it('sends command.cancel when Stop is pressed and announces only start and outcome in the polite live region', async () => {
    const user = userEvent.setup();
    let capturedId = '';
    let currentState: InvocationSummary['state'] = 'queued';
    const rpc = baseRpc()
      .answer('command.invoke', (params) => {
        const inv = params.invocation as { invocation_id: string };
        capturedId = inv.invocation_id;
        return runningSummary(capturedId, 'queued');
      })
      .answer('read.invocation', () => runningSummary(capturedId, currentState))
      .answer('command.cancel', () => runningSummary(capturedId, currentState));

    await renderAt('/health', rpc);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run smoke test' })).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: 'Run smoke test' }));

    await waitFor(() => {
      expect(screen.getByTestId('smoke-live-region').textContent).toBe(
        'Provider smoke test started.',
      );
      expect(screen.getByTestId('smoke-run-status').textContent).toContain('queued');
    });

    // Intermediate state changes update status display without changing the polite live region.
    currentState = 'spawning';
    act(() => {
      rpc.notify('invocation.changed', { invocation_id: capturedId, state: 'spawning' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('smoke-run-status').textContent).toContain('starting');
    });
    expect(screen.getByTestId('smoke-live-region').textContent).toBe(
      'Provider smoke test started.',
    );

    await user.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      expect(rpc.paramsOf('command.cancel')).toEqual([{ invocation_id: capturedId }]);
    });

    act(() => {
      rpc.notify('invocation.result', {
        invocation_id: capturedId,
        outcome: {
          type: 'result',
          exit_code: 130,
          envelope: {
            schemaVersion: 1,
            kind: 'doctor_smoke',
            outcome: 'aborted',
            provider: 'anthropic',
            model: 'claude-haiku-4-5',
            runId: 'agent-smoke-cancel',
            statusToolInvoked: false,
            usage: { turns: 0 },
          },
          text: null,
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('smoke-live-region').textContent).toBe(
        'Provider smoke test aborted.',
      );
    });
  });

  it('has no axe violations', async () => {
    const rpc = baseRpc();
    const { container } = await renderAt('/health', rpc);

    await waitFor(() => {
      expect(screen.getByTestId('agent-smoke-panel')).toBeTruthy();
    });

    await expectNoAxeViolations(container);
  });
});
