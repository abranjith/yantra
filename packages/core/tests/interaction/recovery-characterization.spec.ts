/**
 * @no-llm phase-one recovery characterization.
 *
 * The detailed behavior matrices remain in the focused attempt, typing, fill,
 * widget, and agent suites. This file pins the cross-suite gate and the legacy
 * artifact consumed by the verdict-ledger compatibility tests.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { classifyFailure } from '../../src/interaction/attempt.js';
import {
  normalizeAttemptArtifact,
  toWireAttemptArtifact,
} from '../../src/interaction/escalation.js';
import { PROTOCOL_GAUNTLET, readUtf8 } from '../support/gauntlet.js';

describe('@no-llm recovery characterization gate', () => {
  it('pins the complete protocol half of the 20-fixture gate', () => {
    expect(PROTOCOL_GAUNTLET).toHaveLength(16);
    expect(new Set(PROTOCOL_GAUNTLET.map((entry) => entry.pattern))).toHaveLength(16);
    expect(PROTOCOL_GAUNTLET.filter((entry) => entry.requiresVision)).toEqual([]);
  });

  it('pins transient, terminal, budget, and disabled classification', () => {
    expect(classifyFailure('STALE_ELEMENT_REF')).toBe('transient');
    expect(classifyFailure('WIDGET_MAPPING_UNSAFE')).toBe('terminal');
    expect(classifyFailure('WIDGET_NOT_COMMITTED', { reason: 'budget' })).toBe('terminal');
    expect(classifyFailure('ELEMENT_HIDDEN', { reason: 'disabled' })).toBe('terminal');
  });

  it('reads the checked-in nullable legacy ledger through an explicit UTF-8 decoder', () => {
    // Resolved from this file, never from the working directory: the two
    // invocations that run this suite (`cd packages/core && vitest` and
    // `vitest --root packages/core` from the repository root) disagree about
    // the working directory, and a UTF-8 decoder assertion must not be flaky
    // for a reason that has nothing to do with bytes.
    const path = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'fixtures',
      'artifacts',
      'legacy-attempt-ledger.json',
    );
    const bytes = readFileSync(path);
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    expect(decoded).toBe(readUtf8(path));
    expect(JSON.parse(decoded)).toEqual([
      expect.objectContaining({ strategy: 'overtype', errorCode: 'WIDGET_NOT_COMMITTED' }),
      expect.objectContaining({ strategy: 'locate-editee', errorCode: null }),
    ]);
    const normalized = normalizeAttemptArtifact(JSON.parse(decoded));
    expect(normalized.map((entry) => entry.kind)).toEqual(['failed', 'succeeded']);
    // Absent, not zero. The artifact never measured these, and reading it as
    // "spent nothing, has nothing left, took no time" is a claim it never made.
    for (const entry of normalized) {
      if (entry.kind === 'skipped') continue;
      expect(entry.chargedActions).toBeUndefined();
      expect(entry.remainingActions).toBeUndefined();
      expect(entry.entryEvidence).toBeUndefined();
      // `elapsedMs` is the one measured field the legacy record genuinely
      // carried, so it survives — reading it back is not an invention.
      expect(typeof entry.elapsedMs).toBe('number');
    }
    // Read only: normalization must not rewrite what is on disk.
    expect(readUtf8(path)).toBe(decoded);
  });

  it('is idempotent over its own output, allowlisted evidence included', () => {
    // What makes the legacy-tolerant boundary safe to leave in place wherever a
    // legacy producer still exists.
    const once = toWireAttemptArtifact([
      {
        ordinal: 1,
        strategy: 'driver:listbox',
        axis: 'how',
        verdict: 'succeeded',
        entry_evidence: ['detected-driver'],
        charged_actions: 4,
        remaining_actions: 28,
        elapsed_ms: 120,
        scroll_steps: 3,
        scroll_stop: 'matched',
      },
      { ordinal: 2, strategy: 'open-probe', axis: 'how', verdict: 'skipped', unmet: 'no-signal' },
      {
        attempt: 3,
        strategy: 'overtype',
        axis: 'how',
        errorCode: 'WIDGET_NOT_COMMITTED',
        elapsedMs: 40,
      },
    ]);

    expect(toWireAttemptArtifact(once)).toEqual(once);
    expect(once[0]).toMatchObject({ scroll_steps: 3, scroll_stop: 'matched' });
    // A legacy record still normalizes without inventing measured fields.
    expect(once[2]).not.toHaveProperty('charged_actions');
    expect(once[2]).not.toHaveProperty('entry_evidence');
    // And a successful record never carries a null code.
    expect(once[0]).not.toHaveProperty('error_code');
  });

  it('normalizes arbitrary legacy-shaped artifacts without throwing', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => normalizeAttemptArtifact(value)).not.toThrow();
      }),
    );
  });
});
