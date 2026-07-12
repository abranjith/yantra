import { describe, expect, it } from 'vitest';

import { DeterministicSynthesizer } from '../../src/synthesis/deterministic.js';
import type { SynthesisDoc, SynthesisInput, SynthesisOptions } from '../../src/synthesis/types.js';

/**
 * End-to-end guards for the exact failure modes FEAT-FP-001 exists to kill,
 * driven all the way through `DeterministicSynthesizer.synthesize` (not just
 * the individual evidence stages). Each `it` is one failure mode from the
 * reference "State of EV car sales" artifact.
 */

const FIXED_NOW = new Date('2026-06-15T00:00:00.000Z');

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
    runId: 'run-fm',
    searchProvider: 'tavily',
    ...overrides,
  };
}

function doc(url: string, text: string): SynthesisDoc {
  return {
    url,
    finalUrl: null,
    host: new URL(url).hostname,
    title: null,
    fetchedAt: '2026-06-01T00:00:00.000Z',
    publishedAt: null,
    text,
    excerpt: null,
  };
}

async function brief(input: SynthesisInput, o: SynthesisOptions = opts()) {
  const result = await synth().synthesize(input, o);
  expect(result.isOk).toBe(true);
  if (!result.isOk) {
    throw result.error;
  }
  return result.value.brief;
}

describe('@no-llm synthesis failure modes (FEAT-FP-001)', () => {
  it('(a) drops an off-topic source mixed into an on-topic set', async () => {
    const b = await brief({
      query: 'State of EV car sales in the US in 2026',
      docs: [
        doc(
          'https://coxauto.example.com/ev',
          'US electric vehicle sales fell 28% in 2026 as demand cooled, according to Cox Automotive.',
        ),
        doc(
          'https://autonews.example.com/ev',
          'EV car registrations in the US dropped 19% during 2026 across most states nationwide.',
        ),
        doc(
          'https://nasa.example.gov/mars',
          'NASA scientists confirmed that ancient water once flowed across the surface of Mars.',
        ),
        doc(
          'https://leegality.example.com/esign',
          'Electronic signatures are legally valid and help businesses e-sign documents securely today.',
        ),
      ],
      failures: [],
    });

    const sourceHosts = b.sources.map((source) => source.host);
    expect(sourceHosts).not.toContain('nasa.example.gov');
    expect(sourceHosts).not.toContain('leegality.example.com');
    expect(b.notices.some((n) => n.kind === 'source_excluded')).toBe(true);
    expect(b.metadata.evidence!.excluded_sources).toBeGreaterThanOrEqual(2);

    const findingText = b.key_findings.map((f) => f.text).join(' ');
    expect(findingText).not.toMatch(/Mars|signature/u);
  });

  it('(b) never surfaces a heading as a key finding', async () => {
    const headings = [
      'Top Budget Laptops In 2026',
      'State Wise Laptop Availability And Pricing',
      'Best Student Laptop Picks',
    ];
    const b = await brief({
      query: 'best budget laptops 2026',
      docs: [
        doc('https://seo.example.com/laptops', `${headings.join('. ')}.`),
        doc(
          'https://reviews.example.com/laptops',
          'The Acme UltraBook laptop leads our budget list with strong battery life for 2026. It costs 599 dollars at most retailers and handles student workloads well.',
        ),
      ],
      failures: [],
    });

    for (const finding of b.key_findings) {
      expect(headings).not.toContain(finding.text.replace(/\.\s*$/u, ''));
    }
  });

  it('(c) builds no comparison table of generic percentages for a factual query', async () => {
    const b = await brief({
      query: 'who invented the telephone',
      docs: [
        doc(
          'https://history.example.com/bell',
          'Alexander Graham Bell invented the telephone in 1876 after long experiments with sound.',
        ),
        doc(
          'https://museum.example.com/phone',
          'Website traffic to telephone history museums grew 40% last year, marketing reports said.',
        ),
      ],
      failures: [],
    });

    // Factual intent has no facet plan, so a stray percentage never becomes a table.
    expect(b.facets).toBeNull();
  });

  it('(d) a price query with several money values per doc tables the anchored ones', async () => {
    const b = await brief({
      query: 'cheapest Sony WH-1000XM5 headphones',
      docs: [
        doc(
          'https://amazon.example.com/xm5',
          'The Sony WH-1000XM5 headphones cost $328 at Amazon today. Free shipping applies over $35 orders.',
        ),
        doc(
          'https://bestbuy.example.com/xm5',
          'Best Buy sells the Sony WH-1000XM5 headphones for $349 with pickup. A protection plan adds $59.',
        ),
      ],
      failures: [],
    });

    expect(b.facets).not.toBeNull();
    const cells = b.facets!.comparison!.rows.flat();
    expect(cells).toContain('$328');
    expect(cells).toContain('$349');
    expect(cells).not.toContain('$35');
    expect(cells).not.toContain('$59');
  });

  it('(e) states limited evidence plainly instead of padding a thin set', async () => {
    const b = await brief({
      query: 'state of quantum networking research in 2026',
      docs: [
        doc(
          'https://qnet.example.com/1',
          'Quantum networking research reached a milestone in 2026 with a stable multi-node link.',
        ),
        doc(
          'https://qnet.example.org/2',
          'Researchers demonstrated quantum networking entanglement across a city fiber in 2026.',
        ),
      ],
      failures: [],
    });

    // Two relevant findings, a medium (6) budget: honest, not padded.
    expect(b.key_findings.length).toBeLessThanOrEqual(2);
    expect(b.notices.some((n) => n.kind === 'limited_evidence')).toBe(true);
  });
});
