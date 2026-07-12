import { canonicalBrief, makeBrief, makeSource } from '@yantra/test-helpers';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { renderBriefTerminal, type BriefDetailLevel } from './brief-terminal.js';

const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);
// Built via char code so this source file stays free of literal escape bytes.
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'gu');
const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

const DETAIL_LEVELS: readonly BriefDetailLevel[] = ['overview', 'standard', 'full'];

/** ANSI-free string generator (valid Briefs never contain escape bytes). */
const safeStr = (minLength: number, maxLength: number): fc.Arbitrary<string> =>
  fc
    .string({ minLength, maxLength })
    .filter((value) => !value.includes(ESC) && !value.includes(CSI));

/** A compact valid-Brief arbitrary for the no-color invariant (one source). */
const briefArb = fc
  .record({
    title: safeStr(1, 30),
    overview: safeStr(0, 120),
    findings: fc.array(fc.record({ text: safeStr(1, 50), editorial: fc.boolean() }), {
      maxLength: 5,
    }),
    sections: fc.array(fc.record({ heading: safeStr(1, 20), body: safeStr(0, 80) }), {
      maxLength: 3,
    }),
    comparison: fc.option(fc.array(safeStr(1, 8), { minLength: 1, maxLength: 3 }), { nil: null }),
    notices: fc.array(fc.record({ source: safeStr(0, 15), reason: safeStr(1, 30) }), {
      maxLength: 3,
    }),
  })
  .map((spec) =>
    makeBrief({
      title: spec.title,
      overview: spec.overview,
      key_findings: spec.findings.map((finding) => ({
        text: finding.text,
        citations: finding.editorial ? [] : [1],
        editorial: finding.editorial,
        facet: null,
        children: [],
      })),
      sections: spec.sections.map((section) => ({
        heading: section.heading,
        body_md: section.body,
        citations: [1],
      })),
      facets:
        spec.comparison === null
          ? null
          : { comparison: { columns: spec.comparison, rows: [spec.comparison.map(() => 'x')] } },
      notices: spec.notices.map((notice) => ({
        source: notice.source,
        reason: notice.reason,
        kind: 'other' as const,
      })),
      sources: [makeSource(1)],
    }),
  );

describe('@no-llm renderBriefTerminal', () => {
  for (const detail of DETAIL_LEVELS) {
    for (const noColor of [false, true]) {
      it(`renders the canonical Brief at detail=${detail} noColor=${noColor}`, () => {
        const out = renderBriefTerminal(canonicalBrief, { detail, noColor, width: 80 });
        expect(out).toMatchSnapshot();
      });
    }
  }

  it('emits ANSI color in color mode', () => {
    const out = renderBriefTerminal(canonicalBrief, { detail: 'standard', noColor: false });
    expect(out.includes(ESC)).toBe(true);
  });

  it('honors the overview detail contract (no findings, notices, or sections)', () => {
    const out = stripAnsi(
      renderBriefTerminal(canonicalBrief, { detail: 'overview', noColor: true }),
    );
    expect(out).not.toContain('Key Findings');
    expect(out).not.toContain('Comparison');
    expect(out).not.toContain('Notices');
    expect(out).not.toContain('Price & availability');
    // Overview always shows the title and the sources.
    expect(out).toContain('Cheapest Sony WH-1000XM5 today');
    expect(out).toContain('Sources');
  });

  it('adds sections and per-source lines only at full detail', () => {
    const standard = stripAnsi(
      renderBriefTerminal(canonicalBrief, { detail: 'standard', noColor: true }),
    );
    const full = stripAnsi(renderBriefTerminal(canonicalBrief, { detail: 'full', noColor: true }));

    expect(standard).not.toContain('Price & availability');
    expect(standard).not.toContain('https://www.amazon.com/sony-wh-1000xm5');
    expect(full).toContain('Price & availability');
    expect(full).toContain('https://www.amazon.com/sony-wh-1000xm5');
  });

  it('degrades gracefully when findings, sections, and facets are empty', () => {
    const brief = makeBrief({ key_findings: [], sections: [], facets: null, notices: [] });
    const out = stripAnsi(renderBriefTerminal(brief, { detail: 'full', noColor: true }));

    expect(out).toContain('Test Brief');
    expect(out).not.toContain('Key Findings');
    expect(out).not.toContain('Comparison');
    expect(out).toContain('Sources');
  });

  it('keeps the comparison table within a narrow 60-column width', () => {
    const out = renderBriefTerminal(canonicalBrief, {
      detail: 'standard',
      noColor: true,
      width: 60,
    });
    const tableBorder = /[┌┐└┘├┤┬┴┼│─]/u;
    const tableLines = out.split('\n').filter((line) => tableBorder.test(line));

    expect(tableLines.length).toBeGreaterThan(0);
    for (const line of tableLines) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it('emits zero ANSI escape bytes under noColor for any Brief and detail', () => {
    fc.assert(
      fc.property(briefArb, fc.constantFrom(...DETAIL_LEVELS), (brief, detail) => {
        const out = renderBriefTerminal(brief, { detail, noColor: true });
        expect(out.includes(ESC)).toBe(false);
        expect(out.includes(CSI)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
