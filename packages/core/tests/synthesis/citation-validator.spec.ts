import { createBrief, validateBrief } from '@yantra/protocol';
import type { Brief, BriefSource } from '@yantra/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { validateCitations } from '../../src/synthesis/citation-validator.js';
import { DeterministicSynthesizer } from '../../src/synthesis/deterministic.js';
import type { SynthesisInput, SynthesisOptions } from '../../src/synthesis/types.js';

import { synthesisInputArb } from './arbitraries.js';

const DET_OPTS: SynthesisOptions = {
  strategy: 'deterministic',
  detail: 'standard',
  length: 'medium',
  scope: 'public',
  taskId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  runId: 'run-1',
  searchProvider: null,
};

function source(n: number, host: string, text: string): { source: BriefSource; text: string } {
  return {
    source: {
      n,
      url: `https://${host}/a`,
      final_url: null,
      host,
      title: host,
      fetched_at: '2026-06-01T00:00:00.000Z',
      published_at: null,
    },
    text,
  };
}

function inputFrom(pairs: readonly { source: BriefSource; text: string }[]): SynthesisInput {
  return {
    query: 'q',
    docs: pairs.map((pair) => ({
      url: pair.source.url,
      finalUrl: pair.source.final_url,
      host: pair.source.host,
      title: pair.source.title,
      fetchedAt: pair.source.fetched_at,
      publishedAt: pair.source.published_at,
      text: pair.text,
      excerpt: null,
    })),
    failures: [],
  };
}

describe('@no-llm synthesis/validateCitations', () => {
  it('flags a fabricated claim citing a source that never mentions it', () => {
    const pairs = [
      source(
        1,
        'a.example.com',
        'The council approved the transit budget for the region on Tuesday.',
      ),
    ];
    const brief = createBrief({
      task_id: DET_OPTS.taskId,
      title: 'T',
      overview: 'Overview. [1]',
      key_findings: [
        {
          text: 'Quantum teleportation breakthroughs dominated the summit agenda entirely. [1]',
          citations: [1],
          editorial: false,
          facet: null,
        },
      ],
      sources: pairs.map((p) => p.source),
    });

    const result = validateCitations(brief, inputFrom(pairs), { strategy: 'llm' });

    expect(result.verdict.flagged).toBeGreaterThanOrEqual(1);
    expect(result.brief.notices.some((n) => n.kind === 'uncited_claim_flagged')).toBe(true);
    expect(result.brief.metadata.citation_verdict).not.toBeNull();
  });

  it('strips a fabricated price that appears in no cited source', () => {
    const pairs = [
      source(
        1,
        'a.example.com',
        'Amazon lists the wireless headphones at $328 with free shipping this week.',
      ),
    ];
    const brief = createBrief({
      task_id: DET_OPTS.taskId,
      title: 'T',
      overview: 'Overview. [1]',
      key_findings: [
        {
          text: 'Amazon lists the wireless headphones at $999 in a hidden clearance. [1]',
          citations: [1],
          editorial: false,
          facet: null,
        },
      ],
      sources: pairs.map((p) => p.source),
    });

    const result = validateCitations(brief, inputFrom(pairs), { strategy: 'llm' });

    expect(result.verdict.stripped).toBeGreaterThanOrEqual(1);
    expect(result.brief.key_findings).toHaveLength(0);
    expect(result.brief.notices.some((n) => n.kind === 'uncited_claim_stripped')).toBe(true);
  });

  it('flags an inline [n] marker beyond the source count even though arrays validate', () => {
    const pairs = [
      source(1, 'a.example.com', 'The report covered budget details across the region fully.'),
    ];
    const brief = createBrief({
      task_id: DET_OPTS.taskId,
      title: 'T',
      // Inline [5] is dangling, but the citations arrays only reference [1],
      // so the Brief schema itself accepts this document.
      overview: 'The budget rose sharply this year. [5]',
      key_findings: [
        {
          text: 'The report covered budget details across the region fully. [1]',
          citations: [1],
          editorial: false,
          facet: null,
        },
      ],
      sources: pairs.map((p) => p.source),
    });
    expect(validateBrief(brief).isOk).toBe(true);

    const result = validateCitations(brief, inputFrom(pairs), { strategy: 'llm' });

    expect(result.verdict.flagged).toBeGreaterThanOrEqual(1);
    expect(
      result.brief.notices.some(
        (n) => n.kind === 'uncited_claim_flagged' && n.reason.includes('[5]'),
      ),
    ).toBe(true);
  });

  it('does not run anchoring on the deterministic path (editorial + structural only)', () => {
    const pairs = [source(1, 'a.example.com', 'Short source.')];
    const brief = createBrief({
      task_id: DET_OPTS.taskId,
      title: 'T',
      overview: 'Overview. [1]',
      key_findings: [
        // Weakly anchored, but on the deterministic path anchoring is skipped.
        {
          text: 'A completely unrelated statement about distant galaxies. [1]',
          citations: [1],
          editorial: false,
          facet: null,
        },
      ],
      sources: pairs.map((p) => p.source),
    });

    const result = validateCitations(brief, inputFrom(pairs), { strategy: 'deterministic' });

    expect(result.verdict.flagged).toBe(0);
    expect(result.verdict.stripped).toBe(0);
    expect(result.brief.key_findings).toHaveLength(1);
  });

  it('keeps an editorial finding on the LLM path without anchoring it', () => {
    const pairs = [source(1, 'a.example.com', 'The council approved the budget.')];
    const brief = createBrief({
      task_id: DET_OPTS.taskId,
      title: 'T',
      overview: 'Overview. [1]',
      key_findings: [
        {
          text: 'This looks like a meaningful shift in policy priorities.',
          citations: [],
          editorial: true,
          facet: null,
        },
      ],
      sources: pairs.map((p) => p.source),
    });

    const result = validateCitations(brief, inputFrom(pairs), { strategy: 'llm' });

    expect(result.brief.key_findings).toHaveLength(1);
    expect(result.verdict.stripped).toBe(0);
  });

  it('stamps the verdict into metadata.citation_verdict', () => {
    const pairs = [
      source(1, 'a.example.com', 'The council approved the transit budget on Tuesday afternoon.'),
    ];
    const brief = createBrief({
      task_id: DET_OPTS.taskId,
      title: 'T',
      overview: 'The council approved the transit budget. [1]',
      key_findings: [
        {
          text: 'The council approved the transit budget on Tuesday afternoon. [1]',
          citations: [1],
          editorial: false,
          facet: null,
        },
      ],
      sources: pairs.map((p) => p.source),
    });

    const result = validateCitations(brief, inputFrom(pairs), { strategy: 'llm' });

    expect(result.brief.metadata.citation_verdict).toEqual({
      claims_checked: result.verdict.claimsChecked,
      flagged: result.verdict.flagged,
      stripped: result.verdict.stripped,
    });
  });

  it('leaves the annotated Brief schema-valid after stripping', () => {
    const pairs = [
      source(1, 'a.example.com', 'Amazon lists the headphones at $328 this week only.'),
    ];
    const brief = createBrief({
      task_id: DET_OPTS.taskId,
      title: 'T',
      overview: 'Amazon at $328. [1]',
      key_findings: [
        {
          text: 'Amazon lists the headphones at $328 this week only. [1]',
          citations: [1],
          editorial: false,
          facet: null,
        },
        {
          text: 'A phantom deal drops it to $111. [1]',
          citations: [1],
          editorial: false,
          facet: null,
        },
      ],
      sources: pairs.map((p) => p.source),
    });

    const result = validateCitations(brief, inputFrom(pairs), { strategy: 'llm' });
    expect(validateBrief(result.brief).isOk).toBe(true);
  });

  it('never lets a deterministic Brief produce citation flags over generated corpora (property, 500 runs)', async () => {
    const synth = new DeterministicSynthesizer({
      clock: () => new Date('2026-06-02T00:00:00.000Z'),
    });

    await fc.assert(
      fc.asyncProperty(synthesisInputArb({ maxDocs: 5 }), async (input) => {
        const outcome = await synth.synthesize(input, DET_OPTS);
        expect(outcome.isOk).toBe(true);
        if (!outcome.isOk) return;

        const { brief, verdict } = outcome.value;

        // Deterministic path: zero flags, zero strips (evidence by construction).
        expect(verdict.flagged).toBe(0);
        expect(verdict.stripped).toBe(0);

        // No claim (finding, section, or overview marker) references a source
        // index outside the declared set.
        const declared = new Set(brief.sources.map((s) => s.n));
        const markerCheck = (text: string): void => {
          for (const match of text.matchAll(/\[(\d+)\]/g)) {
            expect(declared.has(Number(match[1]))).toBe(true);
          }
        };
        markerCheck(brief.overview);
        for (const finding of brief.key_findings) {
          markerCheck(finding.text);
          for (const c of finding.citations) {
            expect(declared.has(c)).toBe(true);
          }
        }
        for (const section of brief.sections) {
          markerCheck(section.body_md);
          for (const c of section.citations) {
            expect(declared.has(c)).toBe(true);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it('is idempotent-safe: re-validating an annotated deterministic Brief keeps zero flags', () => {
    // Build a Brief directly and run twice; deterministic strictness means
    // the second pass must also produce zero flags.
    const pairs = [source(1, 'a.example.com', 'The council approved the budget on Tuesday.')];
    const base: Brief = createBrief({
      task_id: DET_OPTS.taskId,
      title: 'T',
      overview: 'The council approved the budget. [1]',
      key_findings: [
        {
          text: 'The council approved the budget on Tuesday. [1]',
          citations: [1],
          editorial: false,
          facet: null,
        },
      ],
      sources: pairs.map((p) => p.source),
    });

    const first = validateCitations(base, inputFrom(pairs), { strategy: 'deterministic' });
    const second = validateCitations(first.brief, inputFrom(pairs), { strategy: 'deterministic' });

    expect(second.verdict.flagged).toBe(0);
    expect(second.verdict.stripped).toBe(0);
  });
});
