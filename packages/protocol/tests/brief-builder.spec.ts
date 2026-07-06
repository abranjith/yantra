import { describe, expect, it } from 'vitest';

import { BriefValidationError, appendNotice, createBrief, validateBrief } from '../src/index.js';
import type { BriefNotice, CreateBriefInput } from '../src/index.js';

import { makeSource } from './brief-factories.js';

const TASK_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const minimalInput: CreateBriefInput = {
  task_id: TASK_ID,
  title: 'Minimal Brief',
  overview: 'Nothing to report.',
};

const notice: BriefNotice = {
  source: 'example.com',
  reason: 'fetch timed out',
  kind: 'fetch_failed',
};

describe('@no-llm brief builder', () => {
  it('assembles a minimal Brief that round-trips through validateBrief', () => {
    const brief = createBrief(minimalInput);

    const result = validateBrief(brief);
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value).toEqual(brief);
    }
  });

  it('generates a fresh ULID brief_id and stamps schema_version 0.2', () => {
    const first = createBrief(minimalInput);
    const second = createBrief(minimalInput);

    expect(first.brief_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first.brief_id).not.toBe(second.brief_id);
    expect(first.schema_version).toBe('0.2');
    expect(first.task_id).toBe(TASK_ID);
  });

  it('defaults collections to empty and facets/metadata sub-fields to null', () => {
    const brief = createBrief(minimalInput);

    expect(brief.key_findings).toEqual([]);
    expect(brief.sections).toEqual([]);
    expect(brief.sources).toEqual([]);
    expect(brief.notices).toEqual([]);
    expect(brief.facets).toBeNull();
    expect(brief.metadata).toEqual({
      search_provider: null,
      synthesis: 'deterministic',
      deterministic_fallback_used: false,
      coverage: null,
      freshness: null,
      citation_verdict: null,
      usage: null,
      run_id: null,
    });
  });

  it('merges partial metadata over the deterministic defaults', () => {
    const brief = createBrief({
      ...minimalInput,
      metadata: { synthesis: 'llm', coverage: 0.5 },
    });

    expect(brief.metadata.synthesis).toBe('llm');
    expect(brief.metadata.coverage).toBe(0.5);
    expect(brief.metadata.deterministic_fallback_used).toBe(false);
    expect(brief.metadata.usage).toBeNull();
  });

  it('assembles a populated Brief that passes validateBrief', () => {
    const brief = createBrief({
      ...minimalInput,
      overview: 'Answer with a citation. [1]',
      sources: [makeSource(1), makeSource(2)],
      key_findings: [{ text: 'Finding [1]', citations: [1], editorial: false, facet: null }],
      sections: [{ heading: 'Detail', body_md: 'Body. [2]', citations: [2] }],
      facets: { comparison: { columns: ['A'], rows: [['x']] } },
      notices: [notice],
    });

    expect(validateBrief(brief).isOk).toBe(true);
  });

  it('copies input arrays defensively instead of aliasing them', () => {
    const sources = [makeSource(1)];
    const brief = createBrief({ ...minimalInput, sources });

    sources.push(makeSource(2));
    expect(brief.sources).toHaveLength(1);
  });

  it('appendNotice returns a new Brief without mutating the input', () => {
    const original = createBrief(minimalInput);
    const extended = appendNotice(original, notice);

    expect(extended).not.toBe(original);
    expect(original.notices).toEqual([]);
    expect(extended.notices).toEqual([notice]);
    expect(validateBrief(extended).isOk).toBe(true);
  });

  it('appendNotice preserves append order across chained calls', () => {
    const second: BriefNotice = { source: 'other.com', reason: 'robots.txt', kind: 'blocked' };
    const brief = appendNotice(appendNotice(createBrief(minimalInput), notice), second);

    expect(brief.notices).toEqual([notice, second]);
  });

  it('validateBrief returns err with actionable paths on garbage — never throws', () => {
    const garbageInputs: unknown[] = [
      null,
      undefined,
      42,
      'not a brief',
      [],
      {},
      { brief_id: 'nope' },
    ];

    garbageInputs.forEach((garbage) => {
      const result = validateBrief(garbage);
      expect(result.isOk).toBe(false);
      if (!result.isOk) {
        expect(result.error).toBeInstanceOf(BriefValidationError);
        expect(result.error.code).toBe('brief_validation_error');
        expect(result.error.issues.length).toBeGreaterThan(0);
        result.error.issues.forEach((issue) => {
          expect(issue.message.length).toBeGreaterThan(0);
          expect(issue.pointer).toBe(issue.path.join('/'));
        });
      }
    });
  });

  it('validateBrief surfaces citation-integrity violations with the offending path', () => {
    const invalid = {
      ...createBrief(minimalInput),
      key_findings: [{ text: 'claim', citations: [3], editorial: false, facet: null }],
    };

    const result = validateBrief(invalid);
    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      const pointers = result.error.issues.map((issue) => issue.pointer);
      expect(pointers).toContain('key_findings/0/citations/0');
      expect(result.error.message).toContain('key_findings/0/citations/0');
    }
  });

  it('validateBrief applies schema defaults to hand-built documents', () => {
    const brief = createBrief({
      ...minimalInput,
      sources: [makeSource(1)],
    });
    // Simulate a document written by an external producer that omits defaulted fields.
    const raw = JSON.parse(JSON.stringify(brief)) as Record<string, unknown>;
    const rawSources = raw['sources'] as Record<string, unknown>[];
    delete rawSources[0]?.['final_url'];

    const result = validateBrief(raw);
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.sources[0]?.final_url).toBeNull();
    }
  });
});
