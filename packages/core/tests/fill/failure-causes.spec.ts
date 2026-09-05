/**
 * The actionable-hint invariant.
 *
 * This is the test the failure table exists for. Every hint declares the detail
 * keys its wording refers to and the engine capability that makes its advice
 * work, and this walks the table asserting both resolve. A hint with no
 * capability is a failing test, not a code-review note — the motivating run
 * lost 13.9 seconds obeying advice ("re-issue with one of those strings exactly
 * as written") that named a move the engine had no path for, and another call
 * to advice that told it to "check details.displayedMonths" on a failure
 * carrying no months.
 */

import { describe, expect, it } from 'vitest';

import {
  assertReceivable,
  classifyFailure,
  fillFailure,
  hintFor,
  missingHintDetails,
  templateFor,
  DanglingHintError,
  FAILURE_TEMPLATES,
  IndistinguishableOfferedError,
  type FailureTemplate,
  type FillCause,
  type FillErrorCode,
} from '../../src/index.js';

/** Every declared pair, flattened for enumeration. */
const PAIRS: readonly {
  readonly code: FillErrorCode;
  readonly cause: FillCause;
  readonly template: FailureTemplate;
}[] = Object.entries(FAILURE_TEMPLATES).flatMap(([code, causes]) =>
  Object.entries(causes as Record<string, FailureTemplate>).map(([cause, template]) => ({
    code: code as FillErrorCode,
    cause: cause as FillCause,
    template,
  })),
);

/** A details payload carrying exactly what one template's wording refers to. */
function detailsFor(template: FailureTemplate): Record<string, unknown> {
  const filled: Record<string, unknown> = {};
  for (const key of template.requiredDetails) {
    filled[key] =
      key === 'offered'
        ? ['San Jose Mineta International Airport (SJC)', 'San Jose del Cabo (SJD)']
        : key === 'attempted'
          ? [{ attempt: 1, strategy: 'overtype', axis: 'how', errorCode: null, elapsedMs: 1 }]
          : key === 'containerResolved'
            ? false
            : key === 'reason'
              ? 'budget'
              : `value-of-${key}`;
  }
  return filled;
}

/** Split a hint into sentences, for the no-repetition check. */
function sentences(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim().toLocaleLowerCase())
    .filter(Boolean);
}

describe('@no-llm failure template invariants', () => {
  it('declares at least one cause for every error code', () => {
    // Totality over the code union is what lets `fillFailure` be typed so an
    // undeclared pair is a compile error rather than a generic sentence.
    for (const [code, causes] of Object.entries(FAILURE_TEMPLATES)) {
      expect({ code, causes: Object.keys(causes as object) }).not.toMatchObject({ causes: [] });
    }
  });

  it('declares every engine capability for each family that emits it', () => {
    // (a) Advice is legal only when the emitting family has a receiver.
    for (const { code, cause, template } of PAIRS) {
      if (template.capability === null) continue;
      expect(template.emittedBy?.length).toBeGreaterThan(0);
      for (const family of template.emittedBy ?? []) {
        expect(() => assertReceivable('fill', code, cause, family)).not.toThrow();
      }
    }
  });

  it('produces a hint whose referenced keys are all present', () => {
    // (b), first half.
    for (const { code, cause, template } of PAIRS) {
      const details = detailsFor(template);
      expect(missingHintDetails(code, cause, details)).toEqual([]);
      expect(hintFor(code, cause, details).length).toBeGreaterThan(0);
    }
  });

  it('keeps every required offered list distinct and quotes only its members', () => {
    for (const { template } of PAIRS) {
      if (!template.requiredDetails.includes('offered')) continue;
      const details = detailsFor(template);
      const offered = details.offered as string[];
      const normalized = offered.map((entry) => entry.trim().toLocaleLowerCase());
      expect(new Set(normalized).size).toBe(offered.length);
      const quotedRuns = [...template.hint(details).matchAll(/"([^"]*)"/g)].map(
        (match) => match[1]!,
      );
      expect(quotedRuns.every((quoted) => offered.includes(quoted))).toBe(true);
    }
  });

  it('refuses duplicate normalized offered labels and names the duplicate', () => {
    expect(() =>
      hintFor('WIDGET_AMBIGUOUS_CHOICE', 'several-matched-equally', {
        offered: ['Dallas, TX', '  dallas tx  '],
      }),
    ).toThrow(IndistinguishableOfferedError);
    try {
      hintFor('WIDGET_AMBIGUOUS_CHOICE', 'several-matched-equally', {
        offered: ['Dallas, TX', '  dallas tx  '],
      });
    } catch (error) {
      expect(error).toMatchObject({ duplicatedLabel: '  dallas tx  ' });
    }
  });

  it('accepts distinct offers and ignores offered-like details for templates that do not declare them', () => {
    expect(() =>
      hintFor('WIDGET_AMBIGUOUS_CHOICE', 'several-matched-equally', {
        offered: ['Dallas', 'Denver'],
      }),
    ).not.toThrow();
    expect(() =>
      hintFor('WIDGET_TARGET_UNREACHABLE', 'date-not-reachable', {
        displayedMonths: ['2026-09'],
        offered: ['same', 'same'],
      }),
    ).not.toThrow();
  });

  it('detects a hint that quotes a choice absent from its offered payload', () => {
    const offered = ['Dallas', 'Denver'];
    const quotedRuns = [...'Choose "Chicago".'.matchAll(/"([^"]*)"/g)].map((match) => match[1]!);
    expect(quotedRuns.every((quoted) => offered.includes(quoted))).toBe(false);
  });

  it('refuses to emit dangling advice when a referenced key is missing', () => {
    // (b), second half. Failing loudly beats shipping a hint that points at a
    // detail the payload does not carry — that is the exact defect being fixed.
    for (const { code, cause, template } of PAIRS) {
      if (template.requiredDetails.length === 0) continue;
      expect(() => hintFor(code, cause, {})).toThrow(DanglingHintError);
    }
  });

  it('gives no two templates the same text', () => {
    // (c) Two failures sharing a code but not a cause must not read alike.
    const rendered = PAIRS.map(({ template }) => template.hint(detailsFor(template)));

    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it('keeps each hint a single instruction with no repeated sentence', () => {
    // (d) The duplicated-remedy shape, forbidden at the source.
    for (const { code, cause, template } of PAIRS) {
      const parts = sentences(template.hint(detailsFor(template)));
      expect({ pair: `${code}/${cause}`, unique: new Set(parts).size }).toEqual({
        pair: `${code}/${cause}`,
        unique: parts.length,
      });
    }
  });

  it('classifies every budget-caused failure as terminal', () => {
    // The reserved-key regression guard. `WIDGET_NOT_COMMITTED` is transient,
    // so a budget-exhausted one is terminal only by `details.reason`; a
    // template that dropped or renamed it would loop the failure to the
    // attempt bound.
    for (const { code, cause, template } of PAIRS) {
      if (cause !== 'budget') continue;
      expect(template.requiredDetails).toContain('reason');
      expect(classifyFailure(code, { ...detailsFor(template), reason: 'budget' })).toBe('terminal');
    }
  });
});

describe('@no-llm failures with one code and different causes read differently', () => {
  it('separates a driver that recognised nothing from a value that is not offered', () => {
    // The run's seq-30 wrong-hint bug: a WIDGET_TARGET_UNREACHABLE with no
    // offered list was answered with advice about a list.
    const unrecognized = fillFailure(
      'WIDGET_TARGET_UNREACHABLE',
      'driver-not-recognized',
      'Nothing recognised the control.',
    );
    const notOffered = fillFailure(
      'WIDGET_TARGET_UNREACHABLE',
      'value-not-offered',
      'The widget does not offer that.',
      { offered: ['Economy', 'Business'] },
    );

    expect(unrecognized.details.hint).not.toBe(notOffered.details.hint);
    expect(String(unrecognized.details.hint)).not.toMatch(/displayedMonths|details\.offered/);
    expect(String(notOffered.details.hint)).toContain('exactly as written');
  });

  it('separates keystrokes landing elsewhere from a control that refused them all', () => {
    const delegated = fillFailure(
      'WIDGET_NOT_COMMITTED',
      'keystrokes-landed-elsewhere',
      'The control is still empty.',
      { editee: 'Search airports' },
    );
    const exhausted = fillFailure(
      'WIDGET_NOT_COMMITTED',
      'typing-exhausted',
      'The control is still empty.',
      {
        attempted: [
          { attempt: 1, strategy: 'overtype', axis: 'how', errorCode: null, elapsedMs: 1 },
        ],
      },
    );

    expect(delegated.details.hint).not.toBe(exhausted.details.hint);
    expect(String(delegated.details.hint)).toContain('Search airports');
    expect(String(exhausted.details.hint)).toContain('Do not repeat those');
  });

  it('never emits the cause it was selected by', () => {
    // `cause` is internal. The tool seam and the tool-calls.jsonl projection
    // stay byte-compatible with what they carried before it existed.
    const failure = fillFailure(
      'WIDGET_NOT_COMMITTED',
      'keystrokes-landed-elsewhere',
      'The control is still empty.',
      { editee: 'Search airports' },
    );

    expect(Object.keys(failure)).not.toContain('cause');
    expect(Object.keys(failure.details)).not.toContain('cause');
    expect(JSON.stringify(failure)).not.toContain('keystrokes-landed-elsewhere');
  });

  it('reports no template for a pair the code cannot produce', () => {
    // The nested table declares only what each code can actually cause, so this
    // pair does not exist — and `fillFailure` will not type-check for it.
    expect(templateFor('FILL_VALUE_INVALID', 'picker-did-not-open')).toBeNull();
  });
});
