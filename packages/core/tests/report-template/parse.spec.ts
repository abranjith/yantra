import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseTemplate, templateBody } from '../../src/report-template/parse.js';

const fixtureUrl = new URL('./fixtures/exec-brief.md', import.meta.url);
const guidedFixtureUrl = new URL('./fixtures/exec-brief-guidance.md', import.meta.url);

function expectError(text: string, pattern: RegExp): void {
  const result = parseTemplate(text);
  expect(result.isOk).toBe(false);
  if (!result.isOk) {
    expect(result.error.some((issue) => pattern.test(issue.message))).toBe(true);
    expect(result.error.every((issue) => issue.line >= 1)).toBe(true);
  }
}

function expectValidOffsets(body: string, slots: readonly { readonly offset: number }[]): void {
  for (const slot of slots) expect(body.slice(slot.offset).startsWith('{{')).toBe(true);
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
      guidance: null,
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
    expect(result.value.slots.every((slot) => slot.guidance === null)).toBe(true);
    expectValidOffsets(result.value.body, result.value.slots);
  });

  it('binds single-line and multi-line guidance and strips directive lines', () => {
    const result = parseTemplate(
      '# Report\n' +
        '<!-- guidance: Lead with the decision. -->\n' +
        '{{ decision | text }}\n' +
        '<!-- guidance:\n' +
        'Explain the main risk\n' +
        'in one sentence.\n' +
        '-->\n' +
        '{{ risk | markdown }}\n',
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.slots.map((slot) => slot.guidance)).toEqual([
      'Lead with the decision.',
      'Explain the main risk in one sentence.',
    ]);
    expect(result.value.body).toBe('# Report\n{{ decision | text }}\n{{ risk | markdown }}\n');
    expectValidOffsets(result.value.body, result.value.slots);
  });

  it('keeps guidance pending across blank lines and headings and binds only the first slot', () => {
    const result = parseTemplate(
      '# Report\n<!-- guidance: Explain the decision. -->\n\n## Decision\n{{ first }} / {{ second }}\n',
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.slots.map((slot) => slot.guidance)).toEqual([
      'Explain the decision.',
      null,
    ]);
    expect(result.value.slots[0]?.headingPath).toEqual(['Report', 'Decision']);
    expectValidOffsets(result.value.body, result.value.slots);
  });

  it('parses the guided fixture without retaining guidance comments in the body', async () => {
    const raw = await readFile(guidedFixtureUrl, 'utf8');
    const result = parseTemplate(raw);
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.slots[1]?.guidance).toBe(
      'Lead with the headline revenue number, then explain the driver in one sentence.',
    );
    expect(result.value.guidance).toBe(
      'British English. CFO audience. Never speculate beyond the sources.',
    );
    expect(result.value.body).not.toContain('<!-- guidance:');
    expectValidOffsets(result.value.body, result.value.slots);
  });

  it('accepts absent frontmatter and defaults unqualified slots to markdown', () => {
    const result = parseTemplate('# Report\n\n{{ body }}\n');
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toMatchObject({
      name: null,
      description: null,
      guidance: null,
      tags: [],
    });
    expect(result.value.slots[0]).toMatchObject({ kind: 'markdown', headingPath: ['Report'] });
    expectValidOffsets(result.value.body, result.value.slots);
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

  it('normalizes document guidance from a folded YAML block scalar', () => {
    const result = parseTemplate(
      '---\n' +
        'guidance: >\n' +
        '  Use British English.\n' +
        '  Address a CFO audience.\n' +
        '---\n' +
        '{{ body }}\n',
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.guidance).toBe('Use British English. Address a CFO audience.');
  });

  it('treats empty frontmatter guidance as absent', () => {
    const result = parseTemplate('---\nguidance: ""\n---\n{{ body }}\n');
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.guidance).toBeNull();
  });

  it('reports non-string document guidance on the frontmatter line', () => {
    const result = parseTemplate('---\nguidance: [brief, direct]\n---\n{{ body }}\n');
    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.error).toContainEqual({
        line: 2,
        message: 'frontmatter guidance must be a string',
      });
    }
  });

  it.each([
    [
      `---\nguidance: ${'a'.repeat(1001)}\n---\n{{ body }}\n`,
      /exceeds the 1000 character limit \(1001\)/i,
    ],
    [
      '---\nguidance: Never echo {{ body }}.\n---\n{{ body }}\n',
      /must not contain template placeholder syntax/i,
    ],
    [
      '---\nguidance: "Avoid \\u001b[31mcolour."\n---\n{{ body }}\n',
      /must not contain raw ANSI escape bytes/i,
    ],
  ])('validates document guidance for %s', (text, pattern) => {
    expectError(text, pattern);
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

  it('strips raw ANSI bytes from model-facing heading text', () => {
    const result = parseTemplate('## \u001bDecision\u009b\n{{ body }}\n');
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.slots[0]?.headingPath).toEqual(['Decision']);
  });

  it('returns the raw body below frontmatter without stripping directives', () => {
    const body = '<!-- guidance: Keep this raw. -->\n{{ body }}\n';
    expect(templateBody(`---\nname: raw\n---\n${body}`)).toBe(body);
    expect(templateBody(body)).toBe(body);
    expect(templateBody(`---\nname: broken\n${body}`)).toBe(`---\nname: broken\n${body}`);
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

  it('keeps raw-file line numbers after stripping a directive', () => {
    const result = parseTemplate(
      '# Report\n<!-- guidance: Explain this value. -->\n\n## Detail\n{{ detail | mystery }}\n',
    );
    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.error).toContainEqual(
        expect.objectContaining({ line: 5, message: expect.stringMatching(/unknown slot kind/i) }),
      );
      expect(result.error.some((issue) => /not followed by a slot/i.test(issue.message))).toBe(
        false,
      );
    }
  });

  it('handles CRLF directives without changing slot semantics or offset validity', () => {
    const lf = parseTemplate(
      '# Report\n<!-- guidance:\nUse the headline.\n-->\n{{ summary }}\n{{ detail }}\n',
    );
    const crlf = parseTemplate(
      '# Report\r\n<!-- guidance:\r\nUse the headline.\r\n-->\r\n{{ summary }}\r\n{{ detail }}\r\n',
    );
    expect(lf.isOk && crlf.isOk).toBe(true);
    if (!lf.isOk || !crlf.isOk) return;
    const withoutOffsets = (slots: typeof lf.value.slots) =>
      slots.map(({ offset: _offset, ...slot }) => slot);
    expect(withoutOffsets(crlf.value.slots)).toEqual(withoutOffsets(lf.value.slots));
    expectValidOffsets(lf.value.body, lf.value.slots);
    expectValidOffsets(crlf.value.body, crlf.value.slots);
  });

  it('retains ordinary HTML comments in the renderable body', () => {
    const result = parseTemplate('# Report\n<!-- TODO: refine this -->\n{{ body }}\n');
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.body).toContain('<!-- TODO: refine this -->');
  });

  it.each([
    ['<!-- guidance: orphaned -->\n# Report\n', /guidance directive is not followed by a slot/i],
    [
      '<!-- guidance: Explain the evidence. -->\n{{ sources }}\n',
      /cannot be attached to the reserved sources slot/i,
    ],
    ['<!-- guidance:\nnever closed', /unterminated guidance directive/i],
    ['<!-- guidance: Explain this. --> trailing\n{{ body }}\n', /must end its line at "-->"/i],
    ['Prefix <!-- guidance: Explain this. -->\n{{ body }}\n', /must occupy their own line/i],
    ['<!-- guidance: -->\n{{ body }}\n', /guidance text must not be empty/i],
    [
      `<!-- guidance: ${'a'.repeat(501)} -->\n{{ body }}\n`,
      /exceeds the 500 character limit \(501\)/i,
    ],
    [
      '<!-- guidance: Do not emit {{ body }}. -->\n{{ body }}\n',
      /must not contain template placeholder syntax/i,
    ],
    [
      '<!-- guidance: Avoid \u001b[31mcolor. -->\n{{ body }}\n',
      /must not contain raw ANSI escape bytes/i,
    ],
    [
      '<!-- guidance: First. -->\n<!-- guidance: Second. -->\n{{ body }}\n',
      /a second guidance directive precedes the same slot \(first on line 1\)/i,
    ],
  ])('returns the guidance error for %s', (text, pattern) => {
    expectError(text, pattern);
  });
});
