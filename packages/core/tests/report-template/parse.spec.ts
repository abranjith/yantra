import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseTemplate } from '../../src/report-template/parse.js';

const fixtureUrl = new URL('./fixtures/exec-brief.md', import.meta.url);

function expectError(text: string, pattern: RegExp): void {
  const result = parseTemplate(text);
  expect(result.isOk).toBe(false);
  if (!result.isOk) {
    expect(result.error.some((issue) => pattern.test(issue.message))).toBe(true);
    expect(result.error.every((issue) => issue.line >= 1)).toBe(true);
  }
}

describe('@no-llm report-template parser', () => {
  it('parses the exec-brief fixture with normalized metadata and heading descriptions', async () => {
    const raw = await readFile(fixtureUrl, 'utf8');
    const result = parseTemplate(raw);
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    expect(result.value).toMatchObject({
      name: 'exec-brief',
      description: 'Weekly executive brief',
      tags: ['weekly', 'work'],
    });
    expect(result.value.slots.map(({ key, kind }) => ({ key, kind }))).toEqual([
      { key: 'title', kind: 'text' },
      { key: 'summary', kind: 'markdown' },
      { key: 'risks', kind: 'list' },
      { key: 'comparison', kind: 'table' },
      { key: 'sources', kind: 'sources' },
    ]);
    expect(result.value.slots.find((slot) => slot.key === 'summary')?.headingPath).toEqual([
      'Executive Summary',
    ]);
    expect(result.value.slots.find((slot) => slot.key === 'comparison')?.columns).toEqual([
      'Vendor',
      'Price',
      'Notes',
    ]);
  });

  it('accepts absent frontmatter and defaults unqualified slots to markdown', () => {
    const result = parseTemplate('# Report\n\n{{ body }}\n');
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toMatchObject({ name: null, description: null, tags: [] });
    expect(result.value.slots[0]).toMatchObject({ kind: 'markdown', headingPath: ['Report'] });
  });

  it('normalizes names and comma-separated tags', () => {
    const result = parseTemplate(
      '---\nname: Weekly Executive Report\ntags: Work, weekly, WORK\n---\n{{ body }}\n',
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.name).toBe('weekly-executive-report');
    expect(result.value.tags).toEqual(['weekly', 'work']);
  });

  it('tracks nested ATX heading paths', () => {
    const result = parseTemplate(
      '# Outer\n## Middle\n### Inner\n{{ detail | text }}\n## Next\n{{ next }}\n',
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.slots[0]?.headingPath).toEqual(['Outer', 'Middle', 'Inner']);
    expect(result.value.slots[1]?.headingPath).toEqual(['Outer', 'Next']);
  });

  it('parses character, word, item, and row constraints', () => {
    const result = parseTemplate(
      '{{ prose | markdown, min_chars=10, max_chars=100, min_words=2, max_words=20 }}\n' +
        '{{ items | list, min=3, max=5 }}\n',
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.slots[0]?.constraints).toEqual({
      minChars: 10,
      maxChars: 100,
      minWords: 2,
      maxWords: 20,
    });
    expect(result.value.slots[1]?.constraints).toEqual({ min: 3, max: 5 });
  });

  it('computes a stable raw-content hash', () => {
    const first = parseTemplate('{{ body }}');
    const second = parseTemplate('{{ body }}');
    const changed = parseTemplate('{{ body }}\n');
    expect(first.isOk && second.isOk && changed.isOk).toBe(true);
    if (!first.isOk || !second.isOk || !changed.isOk) return;
    expect(first.value.hash).toBe(second.value.hash);
    expect(changed.value.hash).not.toBe(first.value.hash);
  });

  it('reports malformed YAML rather than throwing', () => {
    expectError('---\ntags: [broken\n---\n{{ body }}', /malformed YAML/i);
  });

  it.each([
    ['{{ duplicate }}\n{{ duplicate }}', /duplicate slot key/i],
    ['{{ value | mystery }}', /unknown slot kind/i],
    ['{{ sources | list }}', /reserved sources slot/i],
    ['{{ other | sources }}', /reserved for the sources slot/i],
    ['{{ rows | table() }}', /at least one column/i],
    ['{{ body | markdown, max_words=many }}', /non-negative integer/i],
    ['{{ body | markdown, min_words=5, max_words=2 }}', /cannot exceed/i],
    ['# No placeholders', /at least one slot/i],
    ['# Broken\n{{ body', /missing closing/i],
    ['# Broken\nbody }}', /has no opening/i],
  ])('returns structured errors for %s', (text, pattern) => {
    expectError(text, pattern);
  });

  it('reports the complete-file line for malformed placeholders after frontmatter', () => {
    const result = parseTemplate('---\nname: test\n---\n# Heading\n{{ broken\n');
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error[0]?.line).toBe(5);
  });
});
