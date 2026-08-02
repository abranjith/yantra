import { describe, expect, it } from 'vitest';

import {
  BRIEF_SCHEMA_VERSION,
  TemplateManifest,
  TemplateSlot,
  TemplatedReport,
  validateTemplatedReport,
} from '../src/index.js';

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

describe('@no-llm report template manifest protocol', () => {
  const slot = {
    key: 'body',
    kind: 'markdown',
    headingPath: ['Report'],
    columns: null,
    constraints: {},
    guidance: null,
    offset: 0,
  } as const;
  const manifest = {
    name: 'weekly',
    description: 'Weekly report',
    guidance: null,
    tags: ['work'],
    slots: [slot],
    body: '{{ body }}',
    hash: 'a'.repeat(64),
  } as const;

  it('accepts nullable and non-empty guidance on manifests and slots', () => {
    expect(TemplateManifest.safeParse(manifest).success).toBe(true);
    expect(
      TemplateManifest.safeParse({
        ...manifest,
        guidance: 'Use British English.',
        slots: [{ ...slot, guidance: 'Lead with the outcome.' }],
      }).success,
    ).toBe(true);
  });

  it('rejects empty guidance strings', () => {
    expect(TemplateManifest.safeParse({ ...manifest, guidance: '' }).success).toBe(false);
    expect(TemplateSlot.safeParse({ ...slot, guidance: '' }).success).toBe(false);
  });

  it('requires the slot guidance field even when its value is null', () => {
    const { guidance: _guidance, ...missingGuidance } = slot;
    expect(TemplateSlot.safeParse(missingGuidance).success).toBe(false);
  });

  it('keeps the manifest object strict', () => {
    expect(TemplateManifest.safeParse({ ...manifest, unexpected: true }).success).toBe(false);
  });
});
