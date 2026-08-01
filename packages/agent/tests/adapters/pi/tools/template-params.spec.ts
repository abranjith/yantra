import { parseTemplate } from '@yantra/core';
import type { BriefSource, TemplateManifest } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { templateParamsFor } from '../../../../src/adapters/pi/tools/template-params.js';
import { validateSlots } from '../../../../src/adapters/pi/tools/template-validate.js';

const EXEC_TEMPLATE = `---
name: exec-brief
---
# {{ title | text }}

## Executive Summary
{{ summary | markdown, max_words=4 }}

## Key Risks
{{ risks | list, min=3, max=5 }}

## Vendor Comparison
{{ comparison | table(Vendor, Price, Notes) }}

## Sources
{{ sources }}
`;

function manifest(): TemplateManifest {
  const parsed = parseTemplate(EXEC_TEMPLATE);
  if (!parsed.isOk) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

const sources: BriefSource[] = [
  {
    n: 1,
    url: 'https://example.com/one',
    final_url: null,
    host: 'example.com',
    title: 'One',
    excerpt: null,
    fetched_at: '2026-07-31T00:00:00.000Z',
    published_at: null,
  },
  {
    n: 2,
    url: 'https://example.com/two',
    final_url: 'https://example.com/two-final',
    host: 'example.com',
    title: 'Two',
    excerpt: null,
    fetched_at: '2026-07-31T00:00:00.000Z',
    published_at: null,
  },
  {
    n: 3,
    url: 'https://example.com/three',
    final_url: null,
    host: 'example.com',
    title: 'Three',
    excerpt: null,
    fetched_at: '2026-07-31T00:00:00.000Z',
    published_at: null,
  },
];

describe('@no-llm generated template parameters', () => {
  it('closes both objects, excludes sources, and propagates list bounds', () => {
    const schema = templateParamsFor(manifest()) as unknown as {
      additionalProperties: boolean;
      properties: {
        report: {
          additionalProperties: boolean;
          properties: Record<string, Record<string, unknown>>;
        };
      };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.report.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.report.properties)).toEqual([
      'title',
      'summary',
      'risks',
      'comparison',
    ]);
    expect(schema.properties.report.properties.risks).toMatchObject({
      type: 'array',
      minItems: 3,
      maxItems: 5,
    });
  });

  it('uses readable heading paths as slot descriptions', () => {
    const nested = parseTemplate('# Area\n## Decisions\n{{ choice | text }}');
    expect(nested.isOk).toBe(true);
    if (!nested.isOk) return;
    const schema = templateParamsFor(nested.value) as unknown as {
      properties: { report: { properties: Record<string, { description: string }> } };
    };
    expect(schema.properties.report.properties.choice?.description).toContain('Area > Decisions');
  });
});

describe('@no-llm template slot validation', () => {
  const valid = {
    title: 'Weekly status',
    summary: 'Four words fit here',
    risks: ['Risk one [1]', 'Risk two', 'Risk three'],
    comparison: [['Acme', '$10', 'Preferred']],
  };

  it('accepts a fully valid payload', () => {
    expect(validateSlots(manifest(), valid, sources)).toEqual([]);
  });

  it('enforces max_words at the boundary', () => {
    expect(validateSlots(manifest(), valid, sources)).toEqual([]);
    const issues = validateSlots(
      manifest(),
      { ...valid, summary: 'This value contains exactly five words' },
      sources,
    );
    expect(issues).toMatchObject([{ pointer: 'report/summary' }]);
  });

  it('names a table row whose arity differs from the columns', () => {
    const issues = validateSlots(manifest(), { ...valid, comparison: [['Acme', '$10']] }, sources);
    expect(issues).toMatchObject([{ pointer: 'report/comparison/0' }]);
  });

  it('rejects unresolved citations and non-ledger URLs while allowing ledger URLs', () => {
    expect(
      validateSlots(
        manifest(),
        { ...valid, summary: 'See [3] https://example.com/two-final' },
        sources,
      ),
    ).toEqual([]);
    const issues = validateSlots(
      manifest(),
      { ...valid, summary: 'See [7] https://other.example/path' },
      sources,
    );
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.pointer === 'report/summary')).toBe(true);
  });

  it('flags ANSI bytes and echoed placeholders', () => {
    const issues = validateSlots(
      manifest(),
      { ...valid, summary: '\u001b[31m {{ summary }}' },
      sources,
    );
    expect(issues.map((issue) => issue.message).join(' ')).toMatch(/ANSI/);
    expect(issues.map((issue) => issue.message).join(' ')).toMatch(/placeholder/);
  });

  it('reports exactly one list-bound issue at the slot path', () => {
    const issues = validateSlots(
      manifest(),
      { ...valid, risks: ['1', '2', '3', '4', '5', '6'] },
      sources,
    );
    expect(issues).toEqual([
      expect.objectContaining({
        pointer: 'report/risks',
        message: expect.stringContaining('maximum is 5'),
      }),
    ]);
  });

  it('reports missing, unknown, and mistyped slots for non-provider callers', () => {
    const issues = validateSlots(manifest(), { title: 'Only', extra: 'nope' }, []);
    expect(issues.map((issue) => issue.pointer)).toEqual(
      expect.arrayContaining([
        'report/extra',
        'report/summary',
        'report/risks',
        'report/comparison',
      ]),
    );
  });
});
