import type { ConfirmationRequest } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import { InteractiveConfirmationGateway } from '../../src/discovery/interactive-confirmation-gateway.js';

function makeRequest(overrides: Partial<ConfirmationRequest> = {}): ConfirmationRequest {
  return {
    confirmation_id: '01J000000000000000000CONF',
    run_id: 'run-1',
    step_id: 's1',
    action_kind: 'navigate',
    host: 'example.com',
    description: 'Navigate to example.com',
    expected_cost: null,
    consequence: 'unknown',
    requested_at: new Date().toISOString(),
    timeout_ms: null,
    ...overrides,
  };
}

describe('@no-llm InteractiveConfirmationGateway', () => {
  it('renders a consent card to the sink before prompting', async () => {
    const sink = { write: vi.fn() };
    const promptFn = vi.fn(async () => ({ granted: true }));
    const gateway = new InteractiveConfirmationGateway({ sink, promptFn: promptFn as never });

    await gateway.request(makeRequest({ host: 'shop.example', description: 'Buy the item' }));

    expect(sink.write).toHaveBeenCalledTimes(1);
    const card = sink.write.mock.calls[0]?.[0] as string;
    expect(card).toContain('shop.example');
    expect(card).toContain('Buy the item');
  });

  it('returns decision:"granted" with decided_by "user_interactive" when the user confirms', async () => {
    const promptFn = vi.fn(async () => ({ granted: true }));
    const gateway = new InteractiveConfirmationGateway({
      sink: { write: vi.fn() },
      promptFn: promptFn as never,
    });

    const decision = await gateway.request(makeRequest({ confirmation_id: 'conf-1' }));

    expect(decision).toMatchObject({
      confirmation_id: 'conf-1',
      decision: 'granted',
      decided_by: 'user_interactive',
    });
  });

  it('returns decision:"denied" when the user declines', async () => {
    const promptFn = vi.fn(async () => ({ granted: false }));
    const gateway = new InteractiveConfirmationGateway({
      sink: { write: vi.fn() },
      promptFn: promptFn as never,
    });

    const decision = await gateway.request(makeRequest());

    expect(decision.decision).toBe('denied');
  });

  it('fails closed (denied) when the prompt resolves with an undefined answer (Ctrl+C / non-TTY)', async () => {
    const promptFn = vi.fn(async () => ({}));
    const gateway = new InteractiveConfirmationGateway({
      sink: { write: vi.fn() },
      promptFn: promptFn as never,
    });

    const decision = await gateway.request(makeRequest());

    expect(decision.decision).toBe('denied');
  });

  it('shows the expected cost when present, and "unknown" when absent', async () => {
    const sink = { write: vi.fn() };
    const promptFn = vi.fn(async () => ({ granted: true }));
    const gateway = new InteractiveConfirmationGateway({ sink, promptFn: promptFn as never });

    await gateway.request(makeRequest({ expected_cost: { amount: 49.99, currency: 'USD' } }));
    expect(sink.write.mock.calls[0]?.[0]).toContain('49.99 USD');

    sink.write.mockClear();
    await gateway.request(makeRequest({ expected_cost: null }));
    expect(sink.write.mock.calls[0]?.[0]).toContain('unknown');
  });

  it('stamps a fresh decided_at timestamp on every decision', async () => {
    const promptFn = vi.fn(async () => ({ granted: true }));
    const gateway = new InteractiveConfirmationGateway({
      sink: { write: vi.fn() },
      promptFn: promptFn as never,
    });

    const decision = await gateway.request(makeRequest());

    expect(new Date(decision.decided_at).toISOString()).toBe(decision.decided_at);
  });

  it('preserves the confirmation_id from the request in the decision', async () => {
    const promptFn = vi.fn(async () => ({ granted: true }));
    const gateway = new InteractiveConfirmationGateway({
      sink: { write: vi.fn() },
      promptFn: promptFn as never,
    });

    const decision = await gateway.request(makeRequest({ confirmation_id: 'unique-id-123' }));

    expect(decision.confirmation_id).toBe('unique-id-123');
  });
});
