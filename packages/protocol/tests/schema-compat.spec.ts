// @no-llm
/**
 * Schema compatibility in both directions (FEAT-063 TASK-002, plan D7).
 *
 * - **Forward:** every artifact a pre-FEAT-063 executable wrote (run
 *   manifests, `events.jsonl`, `confirmations.jsonl`, `do --json` outcome
 *   records) still parses under the current schemas.
 * - **New values:** `owner_lost` (`TerminationReason`) and `user_app`
 *   (`ConfirmationDecidedBy`) parse under the current schemas.
 * - **Backward limit:** a frozen copy of the previous enum values rejects both
 *   new values. That is the documented limit: an older executable cannot read
 *   a run that recorded either one.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ConfirmationDecidedBy,
  ConfirmationDecision,
  ConfirmationRequest,
  TaskEvent,
  TaskOutcome,
  TerminationReason,
} from '../src/index.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'run-events');

function readJson(...segments: string[]): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, ...segments), 'utf8')) as unknown;
}

function readJsonl(...segments: string[]): unknown[] {
  return readFileSync(join(FIXTURES, ...segments), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/** The enum values every executable before FEAT-063 shipped, frozen here on purpose. */
const PREVIOUS_TERMINATION_REASONS = [
  'model_finished',
  'wall-clock-soft',
  'wall-clock-hard',
  'provider-tokens',
  'tool-budget',
  'repeated-tool-failure',
  'handoff',
  'user_abort',
  'provider_failed',
  'stalled',
  'turn-timeout',
] as const;
const PREVIOUS_DECIDED_BY = ['user_interactive', 'user_cli_confirm', 'timeout'] as const;

const PreviousTerminationReason = z.enum(PREVIOUS_TERMINATION_REASONS);
const PreviousDecidedBy = z.enum(PREVIOUS_DECIDED_BY);

/** The manifest fields the protocol owns; the rest of the manifest is core's. */
const ManifestOutcomeFields = z.object({
  taskOutcome: TaskOutcome,
  terminationReason: TerminationReason,
});
const AgentOutcomeRecord = z.object({
  kind: z.literal('agent_outcome'),
  task_outcome: TaskOutcome,
  termination_reason: TerminationReason,
});

describe('@no-llm legacy fixtures parse under the new schemas', () => {
  it('reads a run manifest for every shipped termination reason', () => {
    const manifests = readJson('legacy', 'agent-manifests.json') as unknown[];
    const reasons = manifests.map((m) => ManifestOutcomeFields.parse(m).terminationReason);

    expect([...reasons].sort()).toEqual([...PREVIOUS_TERMINATION_REASONS].sort());
  });

  it('reads a `do --json` agent_outcome record for every shipped termination reason', () => {
    const records = readJsonl('legacy', 'agent-outcomes.jsonl');

    expect(records.map((r) => AgentOutcomeRecord.parse(r).termination_reason)).toHaveLength(
      PREVIOUS_TERMINATION_REASONS.length,
    );
  });

  it('reads confirmations.jsonl requests and a decision from every old provenance', () => {
    const [request, ...decisions] = readJsonl('legacy', 'confirmations.jsonl');

    expect(ConfirmationRequest.safeParse(request).success).toBe(true);
    expect(decisions.map((d) => ConfirmationDecision.parse(d).decided_by)).toEqual([
      ...PREVIOUS_DECIDED_BY,
    ]);
  });

  it('reads an events.jsonl line of every TaskEvent kind', () => {
    const lines = readJsonl('legacy', 'events.jsonl');
    const kinds = new Set(lines.map((line) => TaskEvent.parse(line).kind));

    expect([...kinds].sort()).toEqual([...TaskEvent.options.map((o) => o.shape.kind.value)].sort());
  });

  it('round-trips every legacy events.jsonl line unchanged', () => {
    for (const line of readJsonl('legacy', 'events.jsonl')) {
      expect(TaskEvent.parse(line)).toEqual(line);
    }
  });
});

describe('@no-llm new values parse under the new schemas', () => {
  it('reads owner_lost on a manifest and on an agent_outcome record', () => {
    expect(
      ManifestOutcomeFields.parse(readJson('new-values', 'owner-lost.manifest.json'))
        .terminationReason,
    ).toBe('owner_lost');
    expect(
      AgentOutcomeRecord.parse(readJson('new-values', 'owner-lost.agent-outcome.json'))
        .termination_reason,
    ).toBe('owner_lost');
  });

  it('reads user_app on a decision and on a confirmation_resolved event', () => {
    expect(
      ConfirmationDecision.parse(readJson('new-values', 'user-app.decision.json')).decided_by,
    ).toBe('user_app');
    expect(
      TaskEvent.parse(readJson('new-values', 'user-app.confirmation-resolved.json')),
    ).toMatchObject({ kind: 'confirmation_resolved', decided_by: 'user_app' });
  });

  it('keeps every previous value, so the change is purely additive', () => {
    expect(TerminationReason.options).toEqual(
      expect.arrayContaining([...PREVIOUS_TERMINATION_REASONS, 'owner_lost']),
    );
    expect(TerminationReason.options).toHaveLength(PREVIOUS_TERMINATION_REASONS.length + 1);
    expect(ConfirmationDecidedBy.options).toEqual([...PREVIOUS_DECIDED_BY, 'user_app']);
  });

  it('keeps confirmation_resolved.decided_by in step with ConfirmationDecidedBy', () => {
    for (const decidedBy of ConfirmationDecidedBy.options) {
      expect(
        TaskEvent.safeParse({
          task_id: 'task',
          at: '2026-11-01T00:00:00.000Z',
          kind: 'confirmation_resolved',
          confirmation_id: '01J00000000000000000000000',
          decision: 'granted',
          decided_by: decidedBy,
        }).success,
      ).toBe(true);
    }
  });
});

describe('@no-llm documented backward limit (D7)', () => {
  it('a previous TerminationReason reader rejects owner_lost', () => {
    expect(PreviousTerminationReason.safeParse('owner_lost').success).toBe(false);
  });

  it('a previous ConfirmationDecidedBy reader rejects user_app', () => {
    expect(PreviousDecidedBy.safeParse('user_app').success).toBe(false);
  });

  it('a previous reader still reads every old value (only the new ones are unreadable)', () => {
    for (const reason of TerminationReason.options.filter((r) => r !== 'owner_lost')) {
      expect(PreviousTerminationReason.safeParse(reason).success).toBe(true);
    }
  });
});

describe('@no-llm consent provenance stays human-only', () => {
  it('ConfirmationDecidedBy has no agent-shaped member', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ConfirmationDecidedBy.options), (value) => {
        expect(value.toLowerCase()).not.toContain('agent');
        expect(value.toLowerCase()).not.toContain('model');
      }),
    );
  });

  it('rejects an agent decider on decisions and resolved events', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('agent', 'model', 'llm', 'assistant', 'agent_auto'),
        (decidedBy) => {
          expect(
            ConfirmationDecision.safeParse({
              confirmation_id: '01J00000000000000000000000',
              decision: 'granted',
              decided_at: '2026-11-01T00:00:00.000Z',
              decided_by: decidedBy,
            }).success,
          ).toBe(false);
          expect(
            TaskEvent.safeParse({
              task_id: 'task',
              at: '2026-11-01T00:00:00.000Z',
              kind: 'confirmation_resolved',
              confirmation_id: '01J00000000000000000000000',
              decision: 'granted',
              decided_by: decidedBy,
            }).success,
          ).toBe(false);
        },
      ),
    );
  });
});

describe('@no-llm fixture directory is complete', () => {
  it('ships the legacy and new-value fixture sets', () => {
    expect(readdirSync(join(FIXTURES, 'legacy')).sort()).toEqual([
      'agent-manifests.json',
      'agent-outcomes.jsonl',
      'confirmations.jsonl',
      'events.jsonl',
    ]);
    expect(readdirSync(join(FIXTURES, 'new-values'))).toEqual(
      expect.arrayContaining([
        'owner-lost.agent-outcome.json',
        'owner-lost.manifest.json',
        'user-app.confirmation-resolved.json',
        'user-app.decision.json',
      ]),
    );
  });
});
