/**
 * @no-llm phase-one recovery characterization.
 *
 * The detailed behavior matrices remain in the focused attempt, typing, fill,
 * widget, and agent suites. This file pins the cross-suite gate and the legacy
 * artifact consumed by the verdict-ledger compatibility tests.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { classifyFailure } from '../../src/interaction/attempt.js';
import { normalizeAttemptArtifact } from '../../src/interaction/escalation.js';
import { PROTOCOL_GAUNTLET, readUtf8 } from '../support/gauntlet.js';

describe('@no-llm recovery characterization gate', () => {
  it('pins the complete protocol half of the 17-fixture gate', () => {
    expect(PROTOCOL_GAUNTLET).toHaveLength(13);
    expect(new Set(PROTOCOL_GAUNTLET.map((entry) => entry.pattern))).toHaveLength(13);
  });

  it('pins transient, terminal, budget, and disabled classification', () => {
    expect(classifyFailure('STALE_ELEMENT_REF')).toBe('transient');
    expect(classifyFailure('WIDGET_MAPPING_UNSAFE')).toBe('terminal');
    expect(classifyFailure('WIDGET_NOT_COMMITTED', { reason: 'budget' })).toBe('terminal');
    expect(classifyFailure('ELEMENT_HIDDEN', { reason: 'disabled' })).toBe('terminal');
  });

  it('reads the checked-in nullable legacy ledger through an explicit UTF-8 decoder', () => {
    const path = join(
      process.cwd(),
      'tests',
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
    expect(normalizeAttemptArtifact(JSON.parse(decoded)).map((entry) => entry.kind)).toEqual([
      'failed',
      'succeeded',
    ]);
  });

  it('normalizes arbitrary legacy-shaped artifacts without throwing', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => normalizeAttemptArtifact(value)).not.toThrow();
      }),
    );
  });
});
