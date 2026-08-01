import { describe, expect, it } from 'vitest';

import { BRIEF_SCHEMA_VERSION, TemplatedReport, validateTemplatedReport } from '../src/index.js';

const report = {
  report_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  schema_version: BRIEF_SCHEMA_VERSION,
  template: {
    name: 'exec-brief',
    source: 'saved',
    path: null,
    hash: 'a'.repeat(64),
  },
  title: 'Executive brief',
  slots: {
    title: 'Executive brief',
    summary: 'A concise summary.',
    risks: ['One', 'Two', 'Three'],
    comparison: [['Vendor', '$10']],
  },
  rendered_md: '# Executive brief\n',
  sources: [],
  metadata: {
    search_provider: null,
    synthesis: 'llm',
    deterministic_fallback_used: false,
    coverage: null,
    freshness: null,
    citation_verdict: null,
    usage: null,
    evidence: null,
    run_id: 'run-1',
  },
  notices: [],
} as const;

describe('@no-llm templated report protocol', () => {
  it('accepts the persisted document shape and all slot value families', () => {
    expect(TemplatedReport.safeParse(report).success).toBe(true);
    const validated = validateTemplatedReport(report);
    expect(validated.isOk).toBe(true);
  });

  it('returns pointer-addressed issues without throwing', () => {
    const validated = validateTemplatedReport({ ...report, title: '' });
    expect(validated.isOk).toBe(false);
    if (!validated.isOk) {
      expect(validated.error.issues).toContainEqual(expect.objectContaining({ pointer: 'title' }));
    }
  });

  it('rejects arbitrary nested slot values', () => {
    const validated = validateTemplatedReport({ ...report, slots: { bad: { nested: true } } });
    expect(validated.isOk).toBe(false);
  });
});
