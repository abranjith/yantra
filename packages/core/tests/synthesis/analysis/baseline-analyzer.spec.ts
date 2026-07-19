import { describe, expect, it } from 'vitest';

import {
  BaselineAnalyzer,
  splitSentences,
} from '../../../src/synthesis/analysis/baseline-analyzer.js';
import { DeterministicSynthesizer } from '../../../src/synthesis/deterministic.js';
import { tokenize } from '../../../src/synthesis/similarity.js';
import type { SynthesisInput, SynthesisOptions } from '../../../src/synthesis/types.js';

const analyzer = new BaselineAnalyzer();

const SAMPLE =
  'Cox Automotive reported that EV sales rose 28% in Q1 2026. The average transaction price was $7,500 lower than a year ago.';

describe('@no-llm synthesis/BaselineAnalyzer sentence + token parity', () => {
  it('segments sentences identically to splitSentences', () => {
    const analysis = analyzer.analyze(SAMPLE);
    expect(analysis.sentences.map((sentence) => sentence.text)).toEqual(splitSentences(SAMPLE));
  });

  it('tokenizes each sentence identically to tokenize', () => {
    const analysis = analyzer.analyze(SAMPLE);
    for (const sentence of analysis.sentences) {
      expect(sentence.tokens).toEqual(tokenize(sentence.text));
    }
  });

  it('exposes lemmas equal to tokens (no baseline morphology)', () => {
    const analysis = analyzer.analyze(SAMPLE);
    for (const sentence of analysis.sentences) {
      expect(sentence.lemmas).toEqual(sentence.tokens);
    }
  });

  it('assigns each sentence a contiguous 0-based index', () => {
    const analysis = analyzer.analyze(SAMPLE);
    analysis.sentences.forEach((sentence, index) => expect(sentence.index).toBe(index));
  });

  it('returns empty analysis for empty text', () => {
    const analysis = analyzer.analyze('');
    expect(analysis.sentences).toEqual([]);
    expect(analysis.entities).toEqual([]);
    expect(analysis.hasFiniteVerb(0)).toBe(false);
  });
});

describe('@no-llm synthesis/BaselineAnalyzer neutral analysis stubs', () => {
  it('reports negated: false for every sentence, including explicit negations', () => {
    const analysis = analyzer.analyze('Sales rose in 2025. Sales did not rise in 2024.');
    for (const sentence of analysis.sentences) {
      expect(sentence.negated).toBe(false);
    }
  });

  it('reports sentiment: 0 for every sentence, including opinionated ones', () => {
    const analysis = analyzer.analyze('This is a fantastic product. The report was terrible.');
    for (const sentence of analysis.sentences) {
      expect(sentence.sentiment).toBe(0);
    }
  });

  it('reports junkScore 0 for any index, junk-looking sentences included', () => {
    const analysis = analyzer.analyze('Home News Sport Business Innovation Culture Arts Travel.');
    expect(analysis.junkScore(0)).toBe(0);
    expect(analysis.junkScore(99)).toBe(0);
    expect(analysis.junkScore(-1)).toBe(0);
  });
});

describe('@no-llm synthesis/BaselineAnalyzer typed entities', () => {
  it('types a currency amount as money and normalizes to digits', () => {
    const [money] = analyzer.analyze('The price fell to $7,500 this week.').entities;
    expect(money).toMatchObject({ kind: 'money', text: '$7,500', normalized: '7500' });
  });

  it('types a percentage as percent', () => {
    const entities = analyzer.analyze('Sales rose 28% year over year.').entities;
    const percent = entities.find((entity) => entity.kind === 'percent');
    expect(percent).toMatchObject({ kind: 'percent', normalized: '28' });
  });

  it('types a quarter-year as date', () => {
    const entities = analyzer.analyze('Adoption accelerated in Q1 2026 nationwide.').entities;
    expect(entities.some((entity) => entity.kind === 'date' && /Q1/u.test(entity.text))).toBe(true);
  });

  it('types a bare calendar year as date', () => {
    const entities = analyzer.analyze('The market shifted sharply during 2026 overall.').entities;
    expect(entities.some((entity) => entity.kind === 'date' && entity.text === '2026')).toBe(true);
  });

  it('types a multi-word capitalized name as named', () => {
    const entities = analyzer.analyze(
      'Cox Automotive published the quarterly figures on schedule.',
    ).entities;
    const named = entities.find((entity) => entity.kind === 'named');
    expect(named).toMatchObject({
      kind: 'named',
      text: 'Cox Automotive',
      normalized: 'cox automotive',
    });
  });

  it('does not re-type a year already claimed as date into a cardinal', () => {
    const entities = analyzer.analyze('Growth continued through 2026 across the sector.').entities;
    const forYear = entities.filter((entity) => entity.text === '2026');
    expect(forYear).toHaveLength(1);
    expect(forYear[0]!.kind).toBe('date');
  });

  it('tags entities with the sentence index they occur in', () => {
    const analysis = analyzer.analyze(SAMPLE);
    for (const entity of analysis.entities) {
      expect(entity.sentenceIndex).toBeGreaterThanOrEqual(0);
      expect(entity.sentenceIndex).toBeLessThan(analysis.sentences.length);
      expect(analysis.sentences[entity.sentenceIndex]!.text).toContain(entity.text);
    }
  });
});

describe('@no-llm synthesis/BaselineAnalyzer hasFiniteVerb', () => {
  const finiteVerb = (sentence: string): boolean => {
    const analysis = analyzer.analyze(sentence);
    return analysis.hasFiniteVerb(0);
  };

  it('accepts a real sentence with a finite verb', () => {
    expect(finiteVerb('EV sales rose sharply across every major state this year.')).toBe(true);
  });

  it('rejects a Title-Case heading with no finite verb', () => {
    expect(finiteVerb('State-Wise EV Sales & Adoption in the U.S.')).toBe(false);
  });

  it('rejects a listicle-style heading fragment', () => {
    expect(finiteVerb('125 Interesting Facts About Electric Cars')).toBe(false);
  });

  it('returns false for an out-of-range sentence index', () => {
    expect(analyzer.analyze('A single sentence here that reads normally.').hasFiniteVerb(9)).toBe(
      false,
    );
  });
});

describe('@no-llm synthesis/BaselineAnalyzer similarity', () => {
  it('scores identical text at (near) 1 and unrelated text near 0', () => {
    const same = analyzer.similarity('electric vehicle sales grew', 'electric vehicle sales grew');
    const different = analyzer.similarity(
      'electric vehicle sales grew this year',
      'the museum opened a new sculpture garden',
    );
    expect(same).toBeGreaterThan(0.9);
    expect(different).toBeLessThan(same);
  });

  it('is symmetric', () => {
    const a = analyzer.similarity('battery range improved', 'range and battery improved');
    const b = analyzer.similarity('range and battery improved', 'battery range improved');
    expect(a).toBeCloseTo(b, 12);
  });
});

// --- Port-shape guarantee: the baseline analyzer, injected explicitly, must
// drive the synthesizer to a stable, byte-identical Brief (modulo brief_id).
// This proves the analyzer seam is a pure function of its input — the property
// the golden suite relies on regardless of which analyzer is the default.
describe('@no-llm synthesis/BaselineAnalyzer port-shape stability', () => {
  const FIXED_NOW = new Date('2026-06-02T00:00:00.000Z');

  function opts(): SynthesisOptions {
    return {
      strategy: 'deterministic',
      detail: 'standard',
      length: 'medium',
      scope: 'public',
      taskId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      runId: 'run-123',
      searchProvider: 'tavily',
    };
  }

  const input: SynthesisInput = {
    query: 'transit budget vote',
    docs: [
      {
        url: 'https://a.example.com/1',
        finalUrl: null,
        host: 'a.example.com',
        title: 'Transit',
        fetchedAt: '2026-06-01T00:00:00.000Z',
        publishedAt: null,
        text: 'The city council approved a forty five million dollar transit budget on Tuesday. Local reporters covered the vote closely.',
        excerpt: null,
      },
      {
        url: 'https://b.example.com/1',
        finalUrl: null,
        host: 'b.example.com',
        title: 'Budget',
        fetchedAt: '2026-06-01T00:00:00.000Z',
        publishedAt: null,
        text: 'The city council approved a forty five million dollar transit budget on Tuesday. Coverage continued through the week.',
        excerpt: null,
      },
    ],
    failures: [],
  };

  it('drives the synthesizer to a byte-identical Brief across runs', async () => {
    const first = await new DeterministicSynthesizer({
      clock: () => FIXED_NOW,
      analyzer: new BaselineAnalyzer(),
    }).synthesize(input, opts());
    const second = await new DeterministicSynthesizer({
      clock: () => FIXED_NOW,
      analyzer: new BaselineAnalyzer(),
    }).synthesize(input, opts());

    expect(first.isOk && second.isOk).toBe(true);
    if (!first.isOk || !second.isOk) return;

    const normalize = (brief: (typeof first.value)['brief']): unknown => ({
      ...brief,
      brief_id: 'FIXED',
    });
    expect(normalize(first.value.brief)).toEqual(normalize(second.value.brief));
  });
});
