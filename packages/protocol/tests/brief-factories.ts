import type { Brief, BriefSource } from '../src/index.js';

export const makeSource = (n: number, overrides: Partial<BriefSource> = {}): BriefSource => ({
  n,
  url: `https://source-${n}.example.com/page`,
  final_url: null,
  host: `source-${n}.example.com`,
  title: `Source ${n}`,
  fetched_at: '2026-07-01T10:00:00.000Z',
  published_at: null,
  ...overrides,
});

export const makeBrief = (overrides: Partial<Brief> = {}): Brief => {
  const base: Brief = {
    brief_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    schema_version: '0.2',
    title: 'Test Brief',
    overview: 'Answer-first overview. [1]',
    key_findings: [{ text: 'Finding one [1]', citations: [1], editorial: false, facet: null }],
    sections: [],
    facets: null,
    sources: [makeSource(1)],
    metadata: {
      search_provider: null,
      synthesis: 'deterministic',
      deterministic_fallback_used: false,
      coverage: null,
      freshness: null,
      citation_verdict: null,
      usage: null,
      run_id: null,
    },
    notices: [],
  };

  return { ...base, ...overrides };
};
