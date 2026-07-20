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
      'Electric bus purchases reached 2400 fleet units across the US during 2026.',
      'Electric motorcycle sales doubled to 80000 units in the US during 2026.',
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

  it('uses a definitional lead and source-informed acronym casing', async () => {
    const input: SynthesisInput = {
      query: 'fifa world cup 2026 news',
      docs: [
        doc({
          url: 'https://a.example.com/world-cup',
          title: 'FIFA World Cup 2026 guide',
          text: 'The 2026 FIFA World Cup is the 23rd edition of the international football tournament.',
        }),
        doc({
          url: 'https://b.example.com/norway',
          title: 'Latest FIFA World Cup news',
          text: 'Norway defeated England to reach an unprecedented FIFA World Cup semi-final.',
        }),
        doc({
          url: 'https://c.example.com/hosts',
          title: 'FIFA tournament hosts',
          text: 'Sixteen host cities are preparing transit services for the 2026 FIFA tournament.',
        }),
      ],
      failures: [],
    };
    const result = await synth().synthesize(input, opts());
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.brief.title).toBe('FIFA World Cup 2026 news');
    expect(
      result.value.brief.overview.startsWith('The 2026 FIFA World Cup is the 23rd edition'),
    ).toBe(true);
  });

  it('emits a capped key-figures table when at least three remainder figures reduce', async () => {
    const figureSentences = [
      'World Cup attendance reached 3,605,357 spectators after the quarter-finals.',
      'The World Cup field expanded to 48 teams for the 2026 tournament.',
      'World Cup matches are scheduled across 16 host cities in 2026.',
      'The World Cup opening ceremony will welcome 70,000 supporters in 2026.',
      'World Cup organizers allocated 12 training bases to qualified teams.',
      'World Cup transit plans add 300 late-night buses for supporters.',
      'World Cup fan zones will operate at 24 public sites during 2026.',
      'World Cup volunteers completed 80 hours of host training this year.',
      'World Cup broadcasters will serve 40 international markets in 2026.',
      'World Cup stadium teams completed 18 emergency drills before opening.',
      'World Cup ticket centers opened 22 service desks across host regions.',
      'World Cup rail operators scheduled 150 extra trains for match days.',
    ];
    const docs = figureSentences.map((text, index) =>
      doc({
        url: `https://figures-${index}.example.com/report`,
        title: 'FIFA World Cup figures',
        text,
      }),
    );
    const result = await synth().synthesize(
      { query: 'world cup host teams figures 2026', docs, failures: [] },
      opts({ detail: 'full', length: 'short' }),
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const numberSection = result.value.brief.sections.find(
      (section) => section.heading === 'Key facts',
    );
    expect(numberSection).toBeDefined();
    expect(numberSection!.body_md).toContain('| Figure | Context | Sources |');
    const dataRows =
      numberSection?.body_md.split('\n').filter((line) => /^\| (?!Figure|---)/u.test(line)) ?? [];
    expect(dataRows.length).toBeGreaterThanOrEqual(3);
    expect(dataRows.length).toBeLessThanOrEqual(12);
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

describe('@no-llm synthesis/DeterministicSynthesizer consolidated sections (FEAT-WI-002)', () => {
  const RETIRED_HEADINGS = ['Numbers & figures', 'People & organizations', 'Notable quotes'];

  /**
   * Mixed corpus: seven distinct numeric claims (kept distinct so the
   * near-duplicate merge does not collapse them) plus five named-organization
   * claims. Yields both a `Key facts` (facts + numbers) and an `Additional
   * findings` (entities) section.
   */
  function mixedInput(): SynthesisInput {
    const sentences = [
      'Electric vehicle sales captured 28% of new registrations.',
      'Electric vehicle chargers numbered 200000 across national highways.',
      'Electric vehicle exports shipped 41000 units toward Europe.',
      'Electric vehicle range averaged 320 miles per charge.',
      'Electric vehicle prices dropped 15% year over year.',
      'Electric vehicle subsidies totalled 3 billion dollars overall.',
      'Electric vehicle recalls affected 7500 sedans recently.',
      'Tesla widened its electric vehicle lineup this season.',
      'Rivian entered the electric vehicle pickup segment recently.',
      'Hyundai reorganised its electric vehicle division here.',
      'Volkswagen retooled several electric vehicle factories abroad.',
      'Toyota expanded its electric vehicle roadmap further.',
    ];
    return {
      query: 'electric vehicle market trends',
      docs: sentences.map((text, i) =>
        doc({ url: `https://ev-${i}.example.com/r`, title: 'EV market', text }),
      ),
      failures: [],
    };
  }

  /**
   * Figures corpus: eight distinct numeric claims (enough survive the finding
   * budget to reduce into a key-figures table) plus three plain fact claims
   * (non-name sentence starts so the local NER does not tag them as entities).
   * The whole set lands in one `Key facts` section: table first, fact bullets
   * after.
   */
  function figuresWithFactsInput(): SynthesisInput {
    const sentences = [
      'The market shipped 41000 electric vehicle exports toward Europe.',
      'The fleet averaged 320 electric vehicle miles per charge.',
      'The programme recalled 7500 electric vehicle sedans recently.',
      'The registry logged 28000 electric vehicle registrations this period.',
      'The grid added 200000 electric vehicle chargers along highways.',
      'The auction cleared 5200 electric vehicle trade-ins overnight.',
      'The dealership stocked 1400 electric vehicle crossovers regionally.',
      'The port handled 9800 electric vehicle imports last month.',
      'The demand for electric vehicles strengthened across rural districts.',
      'The supply of electric vehicles stabilised throughout coastal ports.',
      'The appetite for electric vehicles accelerated among younger commuters.',
    ];
    return {
      query: 'electric vehicle market trends',
      docs: sentences.map((text, i) =>
        doc({ url: `https://ev-${i}.example.com/r`, title: 'EV market', text }),
      ),
      failures: [],
    };
  }

  /** All `[n]` markers rendered in a body, as a sorted, de-duplicated list. */
  function markersIn(bodyMd: string): number[] {
    const markers = new Set<number>();
    for (const match of bodyMd.matchAll(/\[(\d+)\]/gu)) {
      markers.add(Number(match[1]));
    }
    return [...markers].sort((left, right) => left - right);
  }

  it('folds facts and numbers into Key facts and entities into Additional findings', async () => {
    const result = await synth().synthesize(
      mixedInput(),
      opts({ detail: 'full', length: 'short' }),
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const headings = result.value.brief.sections.map((section) => section.heading);
    expect(headings).toEqual(['Key facts', 'Additional findings']);

    const additional = result.value.brief.sections.find(
      (section) => section.heading === 'Additional findings',
    );
    // The named-organization claims are the ones that surface under the generic
    // Additional-findings bucket, never under Key facts.
    expect(additional!.body_md).toMatch(/Tesla|Rivian|Hyundai|Volkswagen|Toyota/u);
  });

  it('renders the key-figures table inside Key facts with bullets following', async () => {
    const result = await synth().synthesize(
      figuresWithFactsInput(),
      opts({ detail: 'full', length: 'short' }),
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const keyFacts = result.value.brief.sections.find((section) => section.heading === 'Key facts');
    expect(keyFacts).toBeDefined();

    const lines = keyFacts!.body_md.split('\n');
    const headerIndex = lines.findIndex((line) =>
      line.startsWith('| Figure | Context | Sources |'),
    );
    expect(headerIndex).toBeGreaterThanOrEqual(0);
    // At least one bullet follows the figures table (unconsumed numbers/facts).
    const bulletsAfterTable = lines.slice(headerIndex).filter((line) => line.startsWith('- '));
    expect(bulletsAfterTable.length).toBeGreaterThanOrEqual(1);
    // The consolidation never re-emits the retired kind-specific headings.
    expect(result.value.brief.sections.map((section) => section.heading)).not.toContain(
      'Numbers & figures',
    );
  });

  it('omits a section that falls below the two-group threshold', async () => {
    // A solid Key-facts corpus plus a single entity claim: the lone entity is
    // too thin for Additional findings, so only Key facts is emitted.
    const base = figuresWithFactsInput();
    const input: SynthesisInput = {
      ...base,
      docs: [
        ...base.docs,
        doc({
          url: 'https://ev-solo.example.com/r',
          title: 'EV market',
          text: 'Tesla widened its electric vehicle lineup this season.',
        }),
      ],
    };
    const result = await synth().synthesize(input, opts({ detail: 'full', length: 'short' }));
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    expect(result.value.brief.sections.map((section) => section.heading)).toEqual(['Key facts']);
  });

  it('emits no sections at detail: overview even when both tiers would qualify', async () => {
    const result = await synth().synthesize(mixedInput(), opts({ detail: 'overview' }));
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    expect(result.value.brief.sections).toEqual([]);
  });

  it('assembles each section citation set as the sorted union of its rendered markers', async () => {
    const result = await synth().synthesize(
      mixedInput(),
      opts({ detail: 'full', length: 'short' }),
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    for (const section of result.value.brief.sections) {
      // Union covers every parent and child citation rendered in the body, and
      // stays ascending and de-duplicated.
      expect(section.citations).toEqual(markersIn(section.body_md));
      expect([...section.citations].sort((a, b) => a - b)).toEqual(section.citations);
      expect(new Set(section.citations).size).toBe(section.citations.length);
    }
    const additional = result.value.brief.sections.find(
      (section) => section.heading === 'Additional findings',
    );
    // The generic bucket draws on several sources, not one.
    expect(additional!.citations.length).toBeGreaterThanOrEqual(2);
  });

  it('never emits the retired kind-specific headings across corpora', async () => {
    const results = await Promise.all([
      synth().synthesize(mixedInput(), opts({ detail: 'full', length: 'short' })),
      synth().synthesize(figuresWithFactsInput(), opts({ detail: 'full', length: 'short' })),
      synth().synthesize(priceCorpus, opts({ detail: 'full' })),
    ]);
    for (const result of results) {
      expect(result.isOk).toBe(true);
      if (!result.isOk) return;
      for (const section of result.value.brief.sections) {
        expect(RETIRED_HEADINGS).not.toContain(section.heading);
      }
    }
  });
});

describe('@no-llm synthesis/DeterministicSynthesizer sentiment opinion demotion (FEAT-WI-003)', () => {
  /**
   * Five neutral numeric claims, one strongly opinionated number claim
   * (sentiment above the gate), one strongly opinionated fact claim, and
   * three entity claims so `Additional findings` always renders. The
   * opinionated claims must never surface under `Key facts`.
   */
  function opinionInput(): SynthesisInput {
    const sentences = [
      'The market shipped 41000 electric vehicle exports toward Europe.',
      'The fleet averaged 320 electric vehicle miles per charge.',
      'The programme recalled 7500 electric vehicle sedans recently.',
      'The registry logged 28000 electric vehicle registrations this period.',
      'The grid added 200000 electric vehicle chargers along highways.',
      'The reviewers called the electric vehicle lineup fantastic, amazing and delightful.',
      'A fantastic 90% of delighted owners praised the amazing electric vehicle lineup.',
      'Tesla widened its electric vehicle lineup this season.',
      'Rivian entered the electric vehicle pickup segment recently.',
      'Hyundai reorganised its electric vehicle division here.',
    ];
    return {
      query: 'electric vehicle market trends',
      docs: sentences.map((text, i) =>
        doc({ url: `https://ev-${i}.example.com/r`, title: 'EV market', text }),
      ),
      failures: [],
    };
  }

  it('keeps strongly opinionated claims out of Key facts', async () => {
    const result = await synth().synthesize(
      opinionInput(),
      opts({ detail: 'full', length: 'short' }),
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const keyFacts = result.value.brief.sections.find((section) => section.heading === 'Key facts');
    expect(keyFacts).toBeDefined();
    expect(keyFacts!.body_md).not.toMatch(/fantastic|amazing|delight/iu);
  });

  it('demotes rather than drops: the opinionated number claim lands in Additional findings with its citation', async () => {
    const result = await synth().synthesize(
      opinionInput(),
      opts({ detail: 'full', length: 'short' }),
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const additional = result.value.brief.sections.find(
      (section) => section.heading === 'Additional findings',
    );
    expect(additional).toBeDefined();
    expect(additional!.body_md).toContain(
      'A fantastic 90% of delighted owners praised the amazing electric vehicle lineup.',
    );
    // The demoted claim keeps its citation — demote never severs evidence.
    expect(additional!.body_md).toMatch(
      /A fantastic 90% of delighted owners praised the amazing electric vehicle lineup\. \[\d+\]/u,
    );
  });

  it('leaves opinionated claims eligible as key findings (demote is section-scoped)', async () => {
    const result = await synth().synthesize(
      opinionInput(),
      opts({ detail: 'full', length: 'short' }),
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    // The strongly opinionated fact claim may still be selected as a key
    // finding — the sentiment gate governs only the Key facts section pool.
    const findingTexts = result.value.brief.key_findings.map((finding) => finding.text);
    expect(findingTexts).toContain(
      'The reviewers called the electric vehicle lineup fantastic, amazing and delightful.',
    );
  });

  it('never renders a sentiment score anywhere in the Brief', async () => {
    const result = await synth().synthesize(
      opinionInput(),
      opts({ detail: 'full', length: 'short' }),
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(JSON.stringify(result.value.brief)).not.toMatch(/sentiment/iu);
  });
});
