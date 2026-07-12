import { describe, expect, it } from 'vitest';

import { WinkAnalyzer } from '../../../src/synthesis/analysis/wink-analyzer.js';
import { DeterministicSynthesizer } from '../../../src/synthesis/deterministic.js';
import type { SynthesisInput, SynthesisOptions } from '../../../src/synthesis/types.js';

const analyzer = new WinkAnalyzer();

describe('@no-llm synthesis/WinkAnalyzer typed entities', () => {
  it('types a currency amount as money and normalizes to digits', () => {
    const money = analyzer
      .analyze('The cheapest model now costs $7,500 today.')
      .entities.find((entity) => entity.kind === 'money');
    expect(money).toMatchObject({ kind: 'money', text: '$7,500', normalized: '7500' });
  });

  it('types a percentage as percent', () => {
    const percent = analyzer
      .analyze('EV sales rose 28% year over year.')
      .entities.find((entity) => entity.kind === 'percent');
    expect(percent).toMatchObject({ kind: 'percent', text: '28%', normalized: '28' });
  });

  it('types a calendar year as date', () => {
    const date = analyzer
      .analyze('EV sales climbed sharply in 2026.')
      .entities.find((entity) => entity.kind === 'date');
    expect(date).toMatchObject({ kind: 'date', normalized: '2026' });
  });

  it('derives a multi-word proper noun as a named entity', () => {
    const named = analyzer
      .analyze('Cox Automotive published the quarterly figures.')
      .entities.find((entity) => entity.kind === 'named');
    expect(named).toMatchObject({
      kind: 'named',
      text: 'Cox Automotive',
      normalized: 'cox automotive',
    });
  });

  it('tags every entity with an in-range sentence index', () => {
    const analysis = analyzer.analyze(
      'Cox Automotive reported the numbers. Prices fell to $38,990 in 2026.',
    );
    for (const entity of analysis.entities) {
      expect(entity.sentenceIndex).toBeGreaterThanOrEqual(0);
      expect(entity.sentenceIndex).toBeLessThan(analysis.sentences.length);
    }
  });
});

describe('@no-llm synthesis/WinkAnalyzer hasFiniteVerb', () => {
  const finiteVerb = (sentence: string): boolean => analyzer.analyze(sentence).hasFiniteVerb(0);

  it('accepts a grammatical sentence with a finite verb', () => {
    expect(finiteVerb('EV sales rose 28% in Q1 2026.')).toBe(true);
  });

  it('rejects a Title-Case heading with no finite verb', () => {
    expect(finiteVerb('State-Wise EV Sales & Adoption in the U.S.')).toBe(false);
  });

  it('rejects a listicle heading fragment', () => {
    expect(finiteVerb('125 Interesting Facts About Electric Cars')).toBe(false);
  });

  it('returns false for an out-of-range sentence index', () => {
    expect(analyzer.analyze('Prices fell sharply this quarter.').hasFiniteVerb(5)).toBe(false);
  });
});

describe('@no-llm synthesis/WinkAnalyzer determinism + caching', () => {
  const TEXT =
    'Cox Automotive reported that EV sales rose 28% in Q1 2026. The average transaction price fell to $38,990 nationwide.';

  it('produces deep-equal sentences and entities across independent instances', () => {
    const left = new WinkAnalyzer().analyze(TEXT);
    const right = new WinkAnalyzer().analyze(TEXT);
    expect(left.sentences).toEqual(right.sentences);
    expect(left.entities).toEqual(right.entities);
  });

  it('memoizes per document: the same instance and text returns one analysis', () => {
    const instance = new WinkAnalyzer();
    expect(instance.analyze(TEXT)).toBe(instance.analyze(TEXT));
  });

  it('scores identical text high and unrelated text lower on similarity', () => {
    const same = analyzer.similarity('electric vehicle sales grew', 'electric vehicle sales grew');
    const different = analyzer.similarity(
      'electric vehicle sales grew this year',
      'the museum opened a new sculpture garden downtown',
    );
    expect(same).toBeGreaterThan(0.9);
    expect(different).toBeLessThan(same);
  });
});

describe('@no-llm synthesis/WinkAnalyzer is the synthesizer default', () => {
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
    query: 'ev sales 2026',
    docs: [
      {
        url: 'https://a.example.com/1',
        finalUrl: null,
        host: 'a.example.com',
        title: 'EV report',
        fetchedAt: '2026-06-01T00:00:00.000Z',
        publishedAt: null,
        text: 'Cox Automotive reported that EV sales rose 28% in Q1 2026 across the country.',
        excerpt: null,
      },
    ],
    failures: [],
  };

  it('matches an explicitly injected WinkAnalyzer', async () => {
    const withDefault = await new DeterministicSynthesizer({ clock: () => FIXED_NOW }).synthesize(
      input,
      opts(),
    );
    const withWink = await new DeterministicSynthesizer({
      clock: () => FIXED_NOW,
      analyzer: new WinkAnalyzer(),
    }).synthesize(input, opts());

    expect(withDefault.isOk && withWink.isOk).toBe(true);
    if (!withDefault.isOk || !withWink.isOk) return;

    const normalize = (brief: (typeof withDefault.value)['brief']): unknown => ({
      ...brief,
      brief_id: 'FIXED',
    });
    expect(normalize(withDefault.value.brief)).toEqual(normalize(withWink.value.brief));
  });
});
