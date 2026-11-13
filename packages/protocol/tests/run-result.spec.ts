// @no-llm
/**
 * The run-result view schemas (FEAT-066 TASK-004): artifact slots, the
 * terminal reason, inventory items and the view itself.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ArtifactInventoryItem,
  BriefSlot,
  JSON_SCHEMA_ARTIFACTS,
  RunResultParams,
  RunResultView,
  TERMINAL_TEXT_MAX,
  TerminalReason,
  artifactSlot,
} from '../src/index.js';

import { makeBrief } from './brief-factories.js';

const Slot = artifactSlot(z.object({ a: z.number() }).strict());

function view(overrides: Record<string, unknown> = {}) {
  return {
    run_id: '20261101T000000Z-fixture-a7b3',
    mode: 'run',
    title: 'fixture',
    started_at: '2026-11-01T00:00:00.000Z',
    ended_at: null,
    duration_ms: null,
    status: 'completed',
    task_outcome: null,
    termination_reason: null,
    execution_state: null,
    live: null,
    document: { kind: 'none' },
    outputs: { state: 'missing', path: 'outputs.json' },
    terminal: null,
    run_health: { state: 'missing', path: 'run-health.json' },
    report: { exists: false, bytes: null },
    artifacts: [],
    artifacts_truncated: false,
    notices_source: 'none',
    ...overrides,
  };
}

describe('artifactSlot', () => {
  it.each([
    { state: 'ok', path: 'x.json', value: { a: 1 } },
    { state: 'missing', path: 'x.json' },
    { state: 'corrupt', path: 'x.json', detail: 'not valid JSON' },
    { state: 'unsupported', path: 'x.json', found_version: '0.1' },
    { state: 'too_large', path: 'x.json', bytes: 10, cap: 5 },
    { state: 'denied', path: 'x.json' },
  ])('accepts the %o state', (slot) => {
    expect(Slot.parse(slot)).toEqual(slot);
  });

  it.each([
    ['an unknown state', { state: 'gone', path: 'x' }],
    ['an ok slot whose value fails its schema', { state: 'ok', path: 'x', value: { a: 'no' } }],
    ['a detail over 200 characters', { state: 'corrupt', path: 'x', detail: 'd'.repeat(201) }],
    ['an extra field (file content)', { state: 'missing', path: 'x', content: 'secret' }],
    ['an empty path', { state: 'missing', path: '' }],
  ])('rejects %s', (_label, slot) => {
    expect(Slot.safeParse(slot).success).toBe(false);
  });

  it('carries a full Brief in the brief slot', () => {
    const slot = { state: 'ok', path: 'brief.json', value: makeBrief() };
    expect(BriefSlot.safeParse(slot).success).toBe(true);
  });
});

describe('TerminalReason', () => {
  it('accepts a bounded reason from each source', () => {
    for (const source of ['run_outcome', 'manifest', 'events', 'report'] as const) {
      expect(TerminalReason.safeParse({ source, message: 'm' }).success).toBe(true);
    }
  });

  it('bounds every text field to 500 characters', () => {
    const long = 'x'.repeat(TERMINAL_TEXT_MAX + 1);
    for (const field of ['failure_class', 'message', 'blocker', 'safest_next_action']) {
      expect(TerminalReason.safeParse({ source: 'report', [field]: long }).success).toBe(false);
    }
  });

  it('accepts only protocol termination reasons', () => {
    expect(
      TerminalReason.safeParse({ source: 'manifest', termination_reason: 'owner_lost' }).success,
    ).toBe(true);
    expect(
      TerminalReason.safeParse({ source: 'manifest', termination_reason: 'gave_up' }).success,
    ).toBe(false);
  });
});

describe('ArtifactInventoryItem', () => {
  it('describes one public file', () => {
    const item = {
      path: 'agent/s.jsonl',
      entry_id: 'agent-session',
      exposure: 'view',
      viewer: 'jsonl',
      bytes: 12,
      modified_at: '2026-11-01T00:00:00.000Z',
      over_inline_cap: false,
    };
    expect(ArtifactInventoryItem.parse(item)).toEqual(item);
    expect(ArtifactInventoryItem.safeParse({ ...item, exposure: 'public' }).success).toBe(false);
  });
});

describe('RunResultView', () => {
  it('accepts a view with no document', () => {
    expect(RunResultView.parse(view())).toEqual(view());
  });

  it('accepts each document kind and the live states', () => {
    for (const live of ['running', 'waiting_for_you', 'unknown_owner']) {
      expect(RunResultView.safeParse(view({ live: { state: live } })).success).toBe(true);
    }
    expect(
      RunResultView.safeParse(
        view({
          document: {
            kind: 'brief',
            slot: { state: 'ok', path: 'brief.json', value: makeBrief() },
          },
          mode: 'ask',
        }),
      ).success,
    ).toBe(true);
    expect(
      RunResultView.safeParse(
        view({
          document: { kind: 'templated_report', slot: { state: 'missing', path: 'document.json' } },
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ['a malformed run id', { run_id: '../x' }],
    ['an unknown mode', { mode: 'browse' }],
    ['a dead live state', { live: { state: 'dead' } }],
    ['more than 2,000 inventory items', { artifacts: Array.from({ length: 2_001 }, () => ({})) }],
    ['an unknown notices source', { notices_source: 'model' }],
  ])('rejects %s', (_label, overrides) => {
    expect(RunResultView.safeParse(view(overrides)).success).toBe(false);
  });

  it('takes a valid run id as params and rejects anything else', () => {
    expect(RunResultParams.safeParse({ run_id: '20261101T000000Z-a' }).success).toBe(true);
    expect(RunResultParams.safeParse({ run_id: 'a/b' }).success).toBe(false);
    expect(RunResultParams.safeParse({ run_id: '20261101T000000Z-a', extra: 1 }).success).toBe(
      false,
    );
  });

  it('is emitted as run-result.schema.json beside list-result and the registry', () => {
    expect(Object.keys(JSON_SCHEMA_ARTIFACTS)).toEqual(
      expect.arrayContaining([
        'run-result.schema.json',
        'list-result.schema.json',
        'run-artifact-registry.json',
      ]),
    );
  });
});
