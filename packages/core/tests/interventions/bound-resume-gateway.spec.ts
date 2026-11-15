import type { ParkedDecisionClaim } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { BoundResumeConfirmationGateway } from '../../src/interventions/bound-resume-gateway.js';

const request = {
  confirmation_id: '01J00000000000000000000020',
  run_id: 'run-1',
  step_id: 'step-1',
  action_kind: 'click' as const,
  host: 'shop.example',
  description: 'Buy',
  expected_cost: null,
  consequence: 'unknown' as const,
  requested_at: '2026-11-03T12:00:00.000Z',
  timeout_ms: null,
  target_host: 'shop.example',
  plan_digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  step_digest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};

const claim: ParkedDecisionClaim = {
  schema_version: 1,
  confirmation_id: '01J00000000000000000000019',
  run_id: 'run-1',
  decision: 'granted',
  decided_by: 'user_app',
  decided_at: '2026-11-03T12:01:00.000Z',
  binding: {
    run_id: request.run_id,
    step_id: request.step_id,
    action_kind: request.action_kind,
    target_host: request.target_host,
    plan_digest: request.plan_digest,
    step_digest: request.step_digest,
  },
};

describe('@no-llm BoundResumeConfirmationGateway', () => {
  it('grants an exact match and preserves original provenance', async () => {
    const gateway = new BoundResumeConfirmationGateway({
      claim,
      now: () => '2026-11-03T12:02:00.000Z',
    });
    await expect(gateway.request(request)).resolves.toMatchObject({
      confirmation_id: request.confirmation_id,
      decision: 'granted',
      decided_by: 'user_app',
      decided_at: claim.decided_at,
      replayed_at: '2026-11-03T12:02:00.000Z',
    });
  });

  it.each([
    ['run_id', { run_id: 'other-run' }],
    ['step_id', { step_id: 'other-step' }],
    ['action_kind', { action_kind: 'fill' as const }],
    ['target_host', { target_host: 'other.example' }],
    ['plan_digest', { plan_digest: 'c'.repeat(64) }],
    ['step_digest', { step_digest: 'd'.repeat(64) }],
  ])('denies a changed %s with a step blocker', async (_field, change) => {
    const gateway = new BoundResumeConfirmationGateway({ claim });
    await expect(gateway.request({ ...request, ...change })).resolves.toMatchObject({
      decision: 'denied',
      blocker: 'The step changed since you approved it.',
    });
  });

  it('denies legacy unbound claims and later flagged steps', async () => {
    const legacy = {
      ...claim,
      binding: { ...claim.binding, plan_digest: null, step_digest: null },
    } satisfies ParkedDecisionClaim;
    const legacyGateway = new BoundResumeConfirmationGateway({ claim: legacy });
    await expect(legacyGateway.request(request)).resolves.toMatchObject({
      decision: 'denied',
      blocker:
        'This approval was recorded before approvals were tied to a step. Run the workflow again.',
    });

    const gateway = new BoundResumeConfirmationGateway({ claim });
    await gateway.request(request);
    await expect(
      gateway.request({ ...request, confirmation_id: '01J00000000000000000000021' }),
    ).resolves.toMatchObject({
      decision: 'denied',
      blocker: 'A second step needs approval; approve it in a new run.',
    });
  });

  it('never grants a denied claim', async () => {
    const gateway = new BoundResumeConfirmationGateway({ claim: { ...claim, decision: 'denied' } });
    await expect(gateway.request(request)).resolves.toMatchObject({ decision: 'denied' });
  });
});
