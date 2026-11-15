// @no-llm
/**
 * Characterization suite for the §15 PreGrantedConfirmationGateway binding gap
 * (FEAT-068 TASK-001).
 *
 * Documents two facts against pre-FEAT-068 source:
 * 1. (Gap, `it.fails`) PreGrantedConfirmationGateway blindly grants the first
 *    request it sees even when step_id, action_kind, and host differ from the
 *    parked request the human approved.
 * 2. (Pinned baseline, `it`) Today's daemon resume gateway already denies a
 *    second flagged step encountered after resume.
 */

import type { ConfirmationRequest } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { isParked } from '../../src/executor/confirmation-gateway.js';
import { PreGrantedConfirmationGateway } from '../../src/scheduler/pregranted-confirmation-gateway.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function makeRequest(overrides: Partial<ConfirmationRequest> = {}): ConfirmationRequest {
  return {
    confirmation_id: '01J00000000000000000000001',
    run_id: '20261103T120000Z-shop-a1b2',
    step_id: 'step_review_order',
    action_kind: 'click',
    host: 'shop.example',
    description: 'Click place order button',
    expected_cost: null,
    consequence: 'unknown',
    requested_at: '2026-11-03T12:00:00.000Z',
    timeout_ms: null,
    ...overrides,
  };
}

describe('@no-llm PreGrantedConfirmationGateway characterization (FEAT-068 TASK-001)', () => {
  it.fails(
    'denies a resumed request whose step_id, action_kind, and host differ from the parked request',
    async () => {
      // The human approved `step_review_order` (`click` on `shop.example`),
      // yet on resume the gateway receives a completely different step.
      const gateway = new PreGrantedConfirmationGateway({ logger: silentLogger });
      const differentRequest = makeRequest({
        confirmation_id: '01J00000000000000000000002',
        step_id: 'step_wire_transfer',
        action_kind: 'submit',
        host: 'bank.evil.example',
        description: 'Submit wire transfer',
      });

      const outcome = await gateway.request(differentRequest);
      expect(isParked(outcome)).toBe(false);
      if (!isParked(outcome)) {
        expect(outcome.decision).toBe('denied');
      }
    },
  );

  it('already denies a second flagged step encountered after resume (§15)', async () => {
    const gateway = new PreGrantedConfirmationGateway({ logger: silentLogger });
    const first = await gateway.request(makeRequest());
    expect(isParked(first)).toBe(false);
    if (!isParked(first)) {
      expect(first.decision).toBe('granted');
    }

    const second = await gateway.request(
      makeRequest({
        confirmation_id: '01J00000000000000000000003',
        step_id: 'step_second_flagged',
        description: 'Second flagged action',
      }),
    );
    expect(isParked(second)).toBe(false);
    if (!isParked(second)) {
      expect(second.decision).toBe('denied');
    }
  });
});
