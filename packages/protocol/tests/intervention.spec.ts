// @no-llm
import { describe, expect, it } from 'vitest';

import {
  DecisionResponse,
  InboxDismissal,
  InboxItem,
  Intervention,
  InterventionLogEntry,
  NotificationAttempt,
  ParkedDecisionClaim,
  UNATTENDED_CEILING_DEFAULT_MS,
} from '../src/index.js';

const ULID_1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID_2 = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const ULID_3 = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const AT = '2026-11-03T12:00:00.000Z';
const HEX64 = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);

const sampleRequest = {
  confirmation_id: ULID_1,
  run_id: '20261103T120000Z-shop-a1b2',
  step_id: 's3',
  action_kind: 'click' as const,
  host: 'shop.example',
  description: 'Confirm checkout',
  expected_cost: null,
  consequence: 'hard_to_reverse' as const,
  requested_at: AT,
  timeout_ms: 180_000,
  target_host: 'shop.example',
  plan_digest: HEX64,
  step_digest: HEX64_B,
};

const sampleConsent = {
  intervention_id: ULID_1,
  run_id: '20261103T120000Z-shop-a1b2',
  kind: 'consent' as const,
  state: 'pending' as const,
  raised_at: AT,
  request: sampleRequest,
  attended_deadline_at: '2026-11-03T12:03:00.000Z',
  deadline_basis: 'request_timeout' as const,
  unattended_ceiling_ms: UNATTENDED_CEILING_DEFAULT_MS,
  unattended_accrued_ms: 0,
  recovery: 'none' as const,
};

describe('@no-llm Intervention schema', () => {
  it('parses every Intervention kind variant', () => {
    expect(Intervention.parse(sampleConsent).kind).toBe('consent');

    const handoff = Intervention.parse({
      intervention_id: ULID_2,
      run_id: 'run-1',
      kind: 'handoff',
      state: 'recorded',
      raised_at: AT,
      handoff: {
        blocker: 'The step changed since you approved it.',
        safest_next_action: 'Run the workflow again and review the updated step.',
      },
      recovery: 'run_again',
    });
    expect(handoff.kind).toBe('handoff');

    const takeover = Intervention.parse({
      intervention_id: ULID_2,
      run_id: 'run-1',
      kind: 'takeover',
      state: 'recorded',
      raised_at: AT,
      handoff: {
        blocker: 'Site requested manual challenge completion.',
        safest_next_action: 'Complete verification manually and run again.',
      },
      recovery: 'none',
    });
    expect(takeover.kind).toBe('takeover');

    const input = Intervention.parse({
      intervention_id: ULID_3,
      run_id: 'run-1',
      kind: 'input',
      state: 'recorded',
      raised_at: AT,
      missing: [
        { label: 'Destination city', reason: 'Not provided in goal' },
        { label: 'Departure date', reason: null },
      ],
      recovery: 'run_again',
    });
    expect(input.kind).toBe('input');
  });

  it('requires request and deadline metadata for consent and rejects recorded state', () => {
    expect(Intervention.safeParse({ ...sampleConsent, request: null }).success).toBe(false);
    expect(Intervention.safeParse({ ...sampleConsent, deadline_basis: null }).success).toBe(false);
    expect(Intervention.safeParse({ ...sampleConsent, unattended_ceiling_ms: null }).success).toBe(
      false,
    );
    expect(Intervention.safeParse({ ...sampleConsent, unattended_accrued_ms: null }).success).toBe(
      false,
    );
    expect(Intervention.safeParse({ ...sampleConsent, state: 'recorded' }).success).toBe(false);
  });

  it('requires handoff for handoff/takeover and missing for input', () => {
    expect(
      Intervention.safeParse({
        intervention_id: ULID_2,
        run_id: 'run-1',
        kind: 'handoff',
        state: 'recorded',
        raised_at: AT,
        handoff: null,
        recovery: 'none',
      }).success,
    ).toBe(false);

    expect(
      Intervention.safeParse({
        intervention_id: ULID_2,
        run_id: 'run-1',
        kind: 'takeover',
        state: 'recorded',
        raised_at: AT,
        recovery: 'none',
      }).success,
    ).toBe(false);

    expect(
      Intervention.safeParse({
        intervention_id: ULID_3,
        run_id: 'run-1',
        kind: 'input',
        state: 'recorded',
        raised_at: AT,
        missing: null,
        recovery: 'run_again',
      }).success,
    ).toBe(false);
  });

  it('rejects ANSI escapes and over-long text on handoff and missing items', () => {
    expect(
      Intervention.safeParse({
        intervention_id: ULID_2,
        run_id: 'run-1',
        kind: 'handoff',
        state: 'recorded',
        raised_at: AT,
        handoff: {
          blocker: 'bad \u001b[31mtext',
          safest_next_action: 'Retry',
        },
        recovery: 'none',
      }).success,
    ).toBe(false);

    expect(
      Intervention.safeParse({
        intervention_id: ULID_2,
        run_id: 'run-1',
        kind: 'handoff',
        state: 'recorded',
        raised_at: AT,
        handoff: {
          blocker: 'x'.repeat(301),
          safest_next_action: 'Retry',
        },
        recovery: 'none',
      }).success,
    ).toBe(false);

    expect(
      Intervention.safeParse({
        intervention_id: ULID_3,
        run_id: 'run-1',
        kind: 'input',
        state: 'recorded',
        raised_at: AT,
        missing: Array.from({ length: 21 }, (_, idx) => ({
          label: `Field ${idx}`,
          reason: null,
        })),
        recovery: 'run_again',
      }).success,
    ).toBe(false);
  });
});

describe('@no-llm InterventionLogEntry, DecisionResponse, ParkedDecisionClaim, NotificationAttempt, Inbox', () => {
  it('parses all InterventionLogEntry variants', () => {
    expect(InterventionLogEntry.parse({ entry: 'raised', intervention: sampleConsent }).entry).toBe(
      'raised',
    );

    expect(
      InterventionLogEntry.parse({
        entry: 'resolved',
        intervention_id: ULID_1,
        decision: {
          confirmation_id: ULID_1,
          decision: 'granted',
          decided_at: AT,
          decided_by: 'user_app',
        },
        reason: 'answered',
        waited_ms: 4200,
        unattended_accrued_ms: 0,
      }).entry,
    ).toBe('resolved');

    expect(InterventionLogEntry.parse({ entry: 'attendance', count: 0, at: AT }).entry).toBe(
      'attendance',
    );
  });

  it('parses all DecisionResponse variants and rejects unknown status', () => {
    expect(
      DecisionResponse.parse({
        status: 'accepted',
        decision: {
          confirmation_id: ULID_1,
          decision: 'granted',
          decided_at: AT,
          decided_by: 'user_app',
        },
      }).status,
    ).toBe('accepted');

    expect(
      DecisionResponse.parse({
        status: 'already_decided',
        decision: 'denied',
        decided_by: 'user_cli_confirm',
        decided_at: AT,
      }).status,
    ).toBe('already_decided');

    expect(DecisionResponse.parse({ status: 'expired', decided_at: AT }).status).toBe('expired');

    expect(DecisionResponse.parse({ status: 'stale', reason: 'earlier_attempt' }).status).toBe(
      'stale',
    );

    expect(DecisionResponse.safeParse({ status: 'maybe', decided_at: AT }).success).toBe(false);
  });

  it('parses ParkedDecisionClaim and rejects invalid fields', () => {
    const claim = {
      schema_version: 1,
      confirmation_id: ULID_1,
      run_id: 'run-1',
      decision: 'granted',
      decided_by: 'user_app',
      decided_at: AT,
      binding: {
        run_id: 'run-1',
        step_id: 's3',
        action_kind: 'click',
        target_host: 'shop.example',
        plan_digest: HEX64,
        step_digest: HEX64_B,
      },
    };
    expect(ParkedDecisionClaim.parse(claim).decision).toBe('granted');
    expect(
      ParkedDecisionClaim.safeParse({ ...claim, decided_by: 'user_interactive' }).success,
    ).toBe(false);
  });

  it('parses NotificationAttempt and rejects free-text detail', () => {
    const attempt = {
      record: 'attempt',
      attempt_id: ULID_2,
      notification_id: ULID_3,
      intervention_id: ULID_1,
      run_id: 'run-1',
      channel: 'desktop',
      status: 'failed',
      at: AT,
      detail: 'nonzero_exit',
    };
    expect(NotificationAttempt.parse(attempt).status).toBe('failed');
    expect(
      NotificationAttempt.safeParse({ ...attempt, detail: 'notify-send crashed with xyz' }).success,
    ).toBe(false);
  });

  it('parses InboxItem and InboxDismissal', () => {
    const item = InboxItem.parse({
      item_id: `intervention:${ULID_1}`,
      kind: 'consent_live',
      run_id: 'run-1',
      invocation_id: null,
      title: 'Confirm checkout',
      raised_at: AT,
      intervention: sampleConsent,
      recovery: 'none',
      dismissible: false,
    });
    expect(item.kind).toBe('consent_live');

    expect(InboxDismissal.parse({ item_id: item.item_id, dismissed_at: AT }).item_id).toBe(
      item.item_id,
    );
  });
});
