import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateBrief } from '@yantra/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DeterministicSynthesizer } from '../../src/synthesis/deterministic.js';
import type { SynthesisDoc, SynthesisInput, SynthesisOptions } from '../../src/synthesis/types.js';

import { synthesisInputArb } from './arbitraries.js';

const priceCorpus = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'price-corpus.json'), 'utf8'),
) as SynthesisInput;

const FIXED_NOW = new Date('2026-06-02T00:00:00.000Z');

function synth(): DeterministicSynthesizer {
  return new DeterministicSynthesizer({ clock: () => FIXED_NOW });
}

function opts(overrides: Partial<SynthesisOptions> = {}): SynthesisOptions {
  return {
    strategy: 'deterministic',
    detail: 'standard',
    length: 'medium',
    scope: 'public',
    taskId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runId: 'run-123',
    searchProvider: 'tavily',
    ...overrides,
  };
}

function doc(overrides: Partial<SynthesisDoc> & { url: string; text: string }): SynthesisDoc {
  return {
    finalUrl: null,
    host: new URL(overrides.url).hostname,
    title: 'Fixture',
    fetchedAt: '2026-06-01T00:00:00.000Z',
    publishedAt: null,
    excerpt: null,
    ...overrides,
  };
}

describe('@no-llm synthesis/DeterministicSynthesizer', () => {
  it('reports the deterministic strategy identity', () => {
    expect(synth().strategy).toBe('deterministic');
  });

  it('assembles a schema-valid Brief from the price corpus', async () => {
    const result = await synth().synthesize(priceCorpus, opts());

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const { brief } = result.value;
    expect(validateBrief(brief).isOk).toBe(true);
    expect(brief.task_id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(brief.metadata.synthesis).toBe('deterministic');
    expect(brief.metadata.usage).toBeNull();
    expect(brief.metadata.run_id).toBe('run-123');
    expect(brief.metadata.search_provider).toBe('tavily');
    expect(result.value.strategyUsed).toBe('deterministic');
    expect(result.value.fallbackUsed).toBe(false);
  });

  it('produces a comparison facet with one row per retailer for the price corpus', async () => {
    const result = await synth().synthesize(priceCorpus, opts());
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const { facets } = result.value.brief;
    expect(facets).not.toBeNull();
    expect(facets!.comparison!.rows).toHaveLength(3);
  });

  it('yields facets: null for a non-comparative corpus', async () => {
    const input: SynthesisInput = {
      query: 'weekend culture roundup',
      docs: [
        doc({
          url: 'https://a.example.com/1',
          text: 'The museum unveiled a new sculpture garden this spring for the public to explore.',
        }),
        doc({
          url: 'https://b.example.com/1',
          text: 'A documentary about coral reefs premiered at the downtown film festival last weekend.',
        }),
      ],
      failures: [],
    };

    const result = await synth().synthesize(input, opts());
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.brief.facets).toBeNull();
  });

  it('respects the length budget for key findings', async () => {
    const docs = Array.from({ length: 12 }, (_, i) =>
      doc({
        url: `https://host-${i}.example.com/a`,
        text: `Report ${i} says revenue reached ${100 + i} million dollars in the quarter under review.`,
      }),
    );
    const input: SynthesisInput = { query: 'revenue report', docs, failures: [] };

    const shortResult = await synth().synthesize(input, opts({ length: 'short' }));
    const mediumResult = await synth().synthesize(input, opts({ length: 'medium' }));
    const longResult = await synth().synthesize(input, opts({ length: 'long' }));

    expect(shortResult.isOk && shortResult.value.brief.key_findings.length).toBeLessThanOrEqual(3);
    expect(mediumResult.isOk && mediumResult.value.brief.key_findings.length).toBeLessThanOrEqual(
      6,
    );
    expect(longResult.isOk && longResult.value.brief.key_findings.length).toBeLessThanOrEqual(10);
  });

  it('emits no sections at detail: overview and some at detail: full', async () => {
    // Sections now hold the *remainder* of accepted claims beyond the finding
    // budget, so this needs more than budget-many *distinct* on-topic claims
    // (near-identical sentences would merge into one).
    const sentences = [
      'Electric vehicle sales fell 28% in the US during 2026 amid tighter supply.',
      'Electric car battery output expanded 45% across the country in 2026.',
      'Electric vehicle charging stations grew to 200000 units nationwide in 2026.',
      'Electric car registrations rose 12% in coastal states during 2026.',
      'Electric vehicle exports climbed 33% to foreign markets in 2026.',
      'Electric truck deliveries increased 60% for commercial fleets in 2026.',
      'Electric car adoption reached 18% of new vehicle sales in 2026.',
      'Electric vehicle model choices expanded to 90 options for buyers in 2026.',
    ];
    const docs = sentences.map((text, i) =>
      doc({ url: `https://ev-${i}.example.com/report`, text }),
    );
    const input: SynthesisInput = { query: 'electric vehicle trends 2026', docs, failures: [] };

    const overviewResult = await synth().synthesize(input, opts({ detail: 'overview' }));
    const fullResult = await synth().synthesize(input, opts({ detail: 'full' }));

    expect(overviewResult.isOk && overviewResult.value.brief.sections).toEqual([]);
    expect(fullResult.isOk && fullResult.value.brief.sections.length).toBeGreaterThan(0);
  });

  it('cites every key finding with declared source numbers', async () => {
    const result = await synth().synthesize(priceCorpus, opts());
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const { brief } = result.value;
    const declared = new Set(brief.sources.map((source) => source.n));
    for (const finding of brief.key_findings) {
      expect(finding.editorial).toBe(false);
      expect(finding.citations.length).toBeGreaterThanOrEqual(1);
      for (const citation of finding.citations) {
        expect(declared.has(citation)).toBe(true);
      }
    }
  });

  it('surfaces a failed source as a fetch_failed notice', async () => {
    const input: SynthesisInput = {
      query: 'transit budget',
      docs: [
        doc({
          url: 'https://ok.example.com/1',
          text: 'The council approved a 45 million dollar transit budget for the coming three years.',
        }),
      ],
      failures: [
        {
          url: 'https://down.example.com/x',
          host: 'down.example.com',
          stage: 'fetch',
          reason: 'timed out',
        },
      ],
    };

    const result = await synth().synthesize(input, opts());
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const notice = result.value.brief.notices.find((n) => n.source === 'down.example.com');
    expect(notice).toBeDefined();
    expect(notice!.kind).toBe('fetch_failed');
  });

  it('maps extract and blocked failures to the matching notice kinds', async () => {
    const input: SynthesisInput = {
      query: 'x',
      docs: [],
      failures: [
        {
          url: 'https://e.example.com/x',
          host: 'e.example.com',
          stage: 'extract',
          reason: 'unreadable',
        },
        {
          url: 'https://b.example.com/x',
          host: 'b.example.com',
          stage: 'blocked',
          reason: 'robots',
        },
      ],
    };

    const result = await synth().synthesize(input, opts());
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const kinds = result.value.brief.notices.map((n) => n.kind).sort();
    expect(kinds).toEqual(['blocked', 'extract_failed']);
  });

  it('produces an empty-but-valid Brief when there are no docs', async () => {
    const input: SynthesisInput = { query: 'nothing here', docs: [], failures: [] };
    const result = await synth().synthesize(input, opts());

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(validateBrief(result.value.brief).isOk).toBe(true);
    expect(result.value.brief.sources).toEqual([]);
    expect(result.value.brief.key_findings).toEqual([]);
    expect(result.value.brief.metadata.coverage).toBeNull();
  });

  it('is deterministic: identical input yields identical Briefs modulo brief_id', async () => {
    const first = await synth().synthesize(priceCorpus, opts());
    const second = await synth().synthesize(priceCorpus, opts());

    expect(first.isOk && second.isOk).toBe(true);
    if (!first.isOk || !second.isOk) return;

    const normalize = (brief: (typeof first.value)['brief']): unknown => ({
      ...brief,
      brief_id: 'FIXED',
    });
    expect(normalize(first.value.brief)).toEqual(normalize(second.value.brief));
  });

  it('always emits a schema-valid Brief over generated corpora (property)', async () => {
    await fc.assert(
      fc.asyncProperty(synthesisInputArb({ maxDocs: 5 }), async (input) => {
        const result = await synth().synthesize(input, opts());
        expect(result.isOk).toBe(true);
        if (!result.isOk) return;
        expect(validateBrief(result.value.brief).isOk).toBe(true);

        // Citations are faithful by construction: no finding references a
        // source number outside the declared set.
        const declared = new Set(result.value.brief.sources.map((s) => s.n));
        for (const finding of result.value.brief.key_findings) {
          for (const citation of finding.citations) {
            expect(declared.has(citation)).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('@no-llm synthesis/DeterministicSynthesizer evidence-first composition', () => {
  const evDocs = [
    'Electric vehicle sales fell 28% in the US during 2026 amid tighter supply.',
    'Electric car battery output expanded 45% across the country in 2026.',
    'Electric vehicle charging stations grew to 200000 units nationwide in 2026.',
    'Electric car registrations rose 12% in coastal states during 2026.',
    'Electric vehicle exports climbed 33% to foreign markets in 2026.',
    'Electric truck deliveries increased 60% for commercial fleets in 2026.',
    'Electric car adoption reached 18% of new vehicle sales in 2026.',
  ].map((text, i) => doc({ url: `https://ev-${i}.example.com/r`, text }));

  const evInput: SynthesisInput = {
    query: 'electric vehicle trends 2026',
    docs: evDocs,
    failures: [],
  };

  it('never repeats a key finding as a section bullet', async () => {
    const result = await synth().synthesize(evInput, opts({ detail: 'full' }));
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const { brief } = result.value;
    const sectionBodies = brief.sections.map((section) => section.body_md).join('\n');
    for (const finding of brief.key_findings) {
      expect(sectionBodies.includes(finding.text)).toBe(false);
    }
  });

  it('carries citations only in the structured array, never as inline [n] in finding text', async () => {
    const result = await synth().synthesize(evInput, opts());
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    for (const finding of result.value.brief.key_findings) {
      expect(finding.text).not.toMatch(/\[\d+\]/u);
      expect(finding.citations.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('stamps metadata.evidence counts consistent with the assembled evidence', async () => {
    const result = await synth().synthesize(evInput, opts());
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const { evidence } = result.value.brief.metadata;
    expect(evidence).not.toBeNull();
    expect(evidence!.accepted_claims).toBeGreaterThan(0);
    expect(evidence!.candidate_claims).toBeGreaterThanOrEqual(evidence!.accepted_claims);
    expect(evidence!.excluded_sources).toBe(0);
  });

  it('excludes an off-topic source with a source_excluded notice and drops it from Sources', async () => {
    const input: SynthesisInput = {
      query: 'electric vehicle trends 2026',
      docs: [
        doc({
          url: 'https://ev.example.com/1',
          text: 'Electric vehicle sales fell 28% in the US during 2026 amid tighter supply.',
        }),
        doc({
          url: 'https://nasa.example.gov/mars',
          text: 'NASA scientists confirmed ancient water once flowed across the surface of Mars.',
        }),
      ],
      failures: [],
    };

    const result = await synth().synthesize(input, opts());
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const { brief } = result.value;
    expect(
      brief.notices.some((n) => n.kind === 'source_excluded' && n.source === 'nasa.example.gov'),
    ).toBe(true);
    expect(brief.sources.some((s) => s.host === 'nasa.example.gov')).toBe(false);
    expect(brief.metadata.evidence!.excluded_sources).toBe(1);
  });

  it('emits a limited_evidence notice when accepted findings fall short of the budget', async () => {
    const input: SynthesisInput = {
      query: 'electric vehicle trends 2026',
      docs: [
        doc({
          url: 'https://a.example.com/1',
          text: 'Electric vehicle sales fell 28% in the US during 2026 amid tighter supply.',
        }),
        doc({
          url: 'https://b.example.com/1',
          text: 'Electric car battery output expanded 45% across the country in 2026.',
        }),
      ],
      failures: [],
    };

    const result = await synth().synthesize(input, opts({ length: 'medium' }));
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    expect(result.value.brief.notices.some((n) => n.kind === 'limited_evidence')).toBe(true);
  });
});
