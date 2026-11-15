// @no-llm
/** Regression coverage for the FEAT-068 parked-resume binding gap. */

import type { ParkedDecisionClaim, ConfirmationRequest } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { BoundResumeConfirmationGateway } from '../../src/interventions/bound-resume-gateway.js';

const binding = {
  run_id: '20261103T120000Z-shop-a1b2',
  step_id: 'step_review_order',
  action_kind: 'click' as const,
  target_host: 'shop.example',
  plan_digest: 'a'.repeat(64),
  step_digest: 'b'.repeat(64),
};

function makeRequest(overrides: Partial<ConfirmationRequest> = {}): ConfirmationRequest {
  return {
    confirmation_id: '01J00000000000000000000001',
    run_id: binding.run_id,
    step_id: binding.step_id,
    action_kind: binding.action_kind,
    host: 'shop.example',
    description: 'Click place order button',
    expected_cost: null,
    consequence: 'unknown',
    requested_at: '2026-11-03T12:00:00.000Z',
    timeout_ms: null,
    target_host: binding.target_host,
    plan_digest: binding.plan_digest,
    step_digest: binding.step_digest,
    ...overrides,
  };
}

const claim: ParkedDecisionClaim = {
  schema_version: 1,
  confirmation_id: '01J00000000000000000000000',
  run_id: binding.run_id,
  decision: 'granted',
  decided_by: 'user_cli_confirm',
  decided_at: '2026-11-03T12:01:00.000Z',
  binding,
};

describe('@no-llm bound parked resume gateway', () => {
  it('denies a resumed request whose step binding differs from the parked approval', async () => {
    const gateway = new BoundResumeConfirmationGateway({ claim });
    const outcome = await gateway.request(
      makeRequest({
        confirmation_id: '01J00000000000000000000002',
        step_id: 'step_wire_transfer',
        host: 'bank.evil.example',
        target_host: 'bank.evil.example',
        description: 'Submit wire transfer',
      }),
    );
    expect(outcome).toMatchObject({
      decision: 'denied',
      blocker: 'The step changed since you approved it.',
    });
  });

  it('denies a second flagged step after a bound grant', async () => {
    const gateway = new BoundResumeConfirmationGateway({ claim });
    await expect(gateway.request(makeRequest())).resolves.toMatchObject({ decision: 'granted' });
    await expect(
      gateway.request(
        makeRequest({
          confirmation_id: '01J00000000000000000000003',
          step_id: 'step_second_flagged',
        }),
      ),
    ).resolves.toMatchObject({
      decision: 'denied',
      blocker: 'A second step needs approval; approve it in a new run.',
    });
  });
});
