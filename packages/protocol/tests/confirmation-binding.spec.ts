// @no-llm
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CONFIRMABLE_ACTION_KINDS,
  ConfirmationDecision,
  ConfirmationRequest,
  ConsequenceLevel,
} from '../src/index.js';

const ULID_1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const AT = '2026-11-03T12:00:00.000Z';
const HEX64_A = '0'.repeat(64);
const HEX64_B = 'f'.repeat(64);

/** Frozen pre-FEAT-063/068 schemas representing an older executable reader. */
const PreviousConfirmationRequest = z.object({
  confirmation_id: z.string().min(1),
  run_id: z.string().min(1),
  step_id: z.string().min(1),
  action_kind: z.enum(CONFIRMABLE_ACTION_KINDS),
  host: z.string().min(1),
  description: z.string().min(1),
  expected_cost: z.object({ amount: z.number(), currency: z.string().min(1) }).nullable(),
  consequence: ConsequenceLevel.default('unknown'),
  requested_at: z.string().datetime(),
  timeout_ms: z.number().int().positive().nullable(),
});

const PreviousConfirmationDecision = z.object({
  confirmation_id: z.string().min(1),
  decision: z.enum(['granted', 'denied', 'timed_out']),
  decided_at: z.string().datetime(),
  decided_by: z.enum(['user_interactive', 'user_cli_confirm', 'timeout']),
});

describe('@no-llm ConfirmationRequest and ConfirmationDecision binding compatibility', () => {
  it('parses old ConfirmationRequest and ConfirmationDecision fixtures without binding or replayed_at', () => {
    const legacyPath = join(
      import.meta.dirname,
      'fixtures',
      'run-events',
      'legacy',
      'confirmations.jsonl',
    );
    const lines = readFileSync(legacyPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);

    const [req, ...decisions] = lines;
    const parsedReq = ConfirmationRequest.parse(req);
    expect(parsedReq.target_host).toBeUndefined();
    expect(parsedReq.plan_digest).toBeUndefined();
    expect(parsedReq.step_digest).toBeUndefined();

    for (const dec of decisions) {
      const parsedDec = ConfirmationDecision.parse(dec);
      expect(parsedDec.replayed_at).toBeUndefined();
    }
  });

  it('parses new binding fields and replayed_at', () => {
    const req = ConfirmationRequest.parse({
      confirmation_id: ULID_1,
      run_id: 'run-1',
      step_id: 's1',
      action_kind: 'click',
      host: 'shop.example:8443',
      description: 'Buy item',
      expected_cost: null,
      consequence: 'irreversible',
      requested_at: AT,
      timeout_ms: null,
      target_host: 'shop.example',
      plan_digest: HEX64_A,
      step_digest: HEX64_B,
    });
    expect(req.target_host).toBe('shop.example');
    expect(req.plan_digest).toBe(HEX64_A);
    expect(req.step_digest).toBe(HEX64_B);

    const dec = ConfirmationDecision.parse({
      confirmation_id: ULID_1,
      decision: 'granted',
      decided_at: AT,
      decided_by: 'user_app',
      replayed_at: '2026-11-03T12:05:00.000Z',
    });
    expect(dec.replayed_at).toBe('2026-11-03T12:05:00.000Z');
  });

  it('rejects malformed target_host, plan_digest, and step_digest', () => {
    const base = {
      confirmation_id: ULID_1,
      run_id: 'run-1',
      step_id: 's1',
      action_kind: 'click' as const,
      host: 'shop.example',
      description: 'Buy',
      expected_cost: null,
      consequence: 'unknown' as const,
      requested_at: AT,
      timeout_ms: null,
    };

    expect(ConfirmationRequest.safeParse({ ...base, target_host: 'Shop.Example' }).success).toBe(
      false,
    );
    expect(
      ConfirmationRequest.safeParse({ ...base, target_host: 'shop.example:8080' }).success,
    ).toBe(false);
    expect(ConfirmationRequest.safeParse({ ...base, plan_digest: 'not-hex' }).success).toBe(false);
    expect(ConfirmationRequest.safeParse({ ...base, step_digest: 'A'.repeat(64) }).success).toBe(
      false,
    );
  });

  it('rejects new fixture against the old schema copy only on the new decided_by enum value (D7)', () => {
    const newBoundRequest = {
      confirmation_id: ULID_1,
      run_id: 'run-1',
      step_id: 's1',
      action_kind: 'click',
      host: 'shop.example',
      description: 'Buy',
      expected_cost: null,
      consequence: 'unknown',
      requested_at: AT,
      timeout_ms: null,
      target_host: 'shop.example',
      plan_digest: HEX64_A,
      step_digest: HEX64_B,
    };
    expect(PreviousConfirmationRequest.safeParse(newBoundRequest).success).toBe(true);

    const replayedCliDecision = {
      confirmation_id: ULID_1,
      decision: 'granted',
      decided_at: AT,
      decided_by: 'user_cli_confirm',
      replayed_at: '2026-11-03T12:05:00.000Z',
    };
    expect(PreviousConfirmationDecision.safeParse(replayedCliDecision).success).toBe(true);

    const appDecision = {
      confirmation_id: ULID_1,
      decision: 'granted',
      decided_at: AT,
      decided_by: 'user_app',
      replayed_at: '2026-11-03T12:05:00.000Z',
    };
    expect(PreviousConfirmationDecision.safeParse(appDecision).success).toBe(false);
  });

  it('round-trips ConfirmationRequest through JSON with any subset of optional binding fields', () => {
    const hex64Arb = fc
      .array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 64, maxLength: 64 })
      .map((chars) => chars.join(''));
    const hostArb = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
        minLength: 1,
        maxLength: 20,
      })
      .map((chars) => `${chars.join('')}.example`);

    fc.assert(
      fc.property(
        fc.option(hostArb, { nil: undefined }),
        fc.option(hex64Arb, { nil: undefined }),
        fc.option(hex64Arb, { nil: undefined }),
        fc.option(fc.integer({ min: 1, max: 600_000 }), { nil: null }),
        (targetHost, planDigest, stepDigest, timeoutMs) => {
          const input: Record<string, unknown> = {
            confirmation_id: ULID_1,
            run_id: 'run-prop',
            step_id: 's1',
            action_kind: 'click',
            host: targetHost ?? 'shop.example',
            description: 'Confirm action',
            expected_cost: null,
            consequence: 'unknown',
            requested_at: AT,
            timeout_ms: timeoutMs,
          };
          if (targetHost !== undefined) input['target_host'] = targetHost;
          if (planDigest !== undefined) input['plan_digest'] = planDigest;
          if (stepDigest !== undefined) input['step_digest'] = stepDigest;

          const parsed = ConfirmationRequest.parse(input);
          const roundTripped = ConfirmationRequest.parse(
            JSON.parse(JSON.stringify(parsed)) as unknown,
          );
          expect(roundTripped).toEqual(parsed);
        },
      ),
    );
  });
});
