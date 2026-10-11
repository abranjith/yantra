import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sanitize, sanitizeStructured } from '../../src/sanitizer/index.js';
import { STRUCTURED_TRUNCATION_MARKER } from '../../src/sanitizer/structured.js';

/** Third-party canaries the authenticated profile must destroy at any depth. */
const CANARIES = {
  email: 'jane.canary@example.com',
  ssn: '123-45-6789',
  card: '4111111111111111',
  phone: '+1 415 555 0172',
  apiKey: 'sk-CanaryKey0123456789abcd',
  tokenQuery: 'tok_CANARY_SECRET',
} as const;

const CANARY_TEXT = [
  CANARIES.email,
  CANARIES.ssn,
  CANARIES.card,
  CANARIES.phone,
  CANARIES.apiKey,
  `https://api.example.net/callback?token=${CANARIES.tokenQuery}`,
] as const;

/** Every canary value that must never appear in the output. */
const CANARY_NEEDLES: readonly string[] = Object.values(CANARIES);

// Segments end in a letter: the card/phone redactors are deliberately greedy,
// so a URL ending in a digit followed by a space and a digit canary is one
// card-shaped run to them (`…/0 4111…`), in the text path too.
const segment = fc.stringMatching(/^[a-z0-9]{0,7}[a-z]$/);
const host = fc.constantFrom('dealer.example', 'cars.example.org', 'news.example.com');

/** A benign query-free URL that `new URL()` round-trips byte-identically. */
const benignUrl = fc
  .tuple(host, fc.array(segment, { minLength: 1, maxLength: 3 }), fc.boolean())
  .map(([h, path, slash]) => `https://${h}/${path.join('/')}${slash ? '/' : ''}`);

/** Characters that become JSON escapes when the leaf is serialized. */
const escapeBoundary = fc.constantFrom('"', '\\', '\n', '');

const word = fc.constantFrom('listing', 'price', 'Calligraphy', 'AWD', 'near', 'mi.', 'MSRP');

interface Piece {
  readonly text: string;
  readonly url?: string;
}

const piece: fc.Arbitrary<Piece> = fc.oneof(
  word.map((text) => ({ text })),
  fc
    .tuple(benignUrl, escapeBoundary)
    .map(([url, boundary]) => ({ text: `${url}${boundary}`, url })),
  fc.constantFrom(...CANARY_TEXT).map((text) => ({ text })),
);

/** A string leaf mixing words, URLs ending at escape boundaries, and canaries. */
const mixedLeaf = fc.array(piece, { minLength: 1, maxLength: 6 }).map((pieces) => ({
  text: pieces.map((p) => p.text).join(' '),
  urls: pieces.flatMap((p) => (p.url === undefined ? [] : [p.url])),
}));

const key = fc.constantFrom('text', 'title', 'url', 'snippet', 'content', 'items', 'type');

interface Generated {
  readonly value: unknown;
  readonly urls: readonly string[];
}

/** A nested tree whose leaves come from `leaf`. */
function treeOf(leaf: fc.Arbitrary<Generated>): fc.Arbitrary<Generated> {
  const { node } = fc.letrec<{ node: Generated }>((tie) => ({
    node: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      leaf,
      fc.array(tie('node'), { maxLength: 3 }).map((children) => ({
        value: children.map((c) => c.value),
        urls: children.flatMap((c) => c.urls),
      })),
      fc.dictionary(key, tie('node'), { maxKeys: 3 }).map((dict) => ({
        value: Object.fromEntries(Object.entries(dict).map(([k, c]) => [k, c.value])),
        urls: Object.values(dict).flatMap((c) => c.urls),
      })),
    ),
  }));
  return node;
}

const level0Leaf: fc.Arbitrary<Generated> = mixedLeaf.map((m) => ({ value: m.text, urls: m.urls }));
const level0 = treeOf(level0Leaf);
/** Leaves at level 1 may be JSON text of a level-0 tree. */
const level1 = treeOf(
  fc.oneof(
    level0Leaf,
    level0.map((g) => ({ value: JSON.stringify(g.value), urls: g.urls })),
  ),
);
/** Leaves at level 2 may be JSON text of a level-1 tree: JSON-in-string two levels deep. */
const level2 = treeOf(
  fc.oneof(
    level0Leaf,
    level1.map((g) => ({ value: JSON.stringify(g.value), urls: g.urls })),
  ),
);
const payload = level2.map((g) => ({
  value: { content: [{ type: 'text', text: g.value }] },
  urls: g.urls,
}));

/** Parse a string leaf as an embedded JSON object/array, or undefined. */
function embedded(text: string): unknown {
  if (!/^\s*[[{]/.test(text)) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Every string anywhere in the value, decoding embedded JSON recursively. */
function allStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    const inner = embedded(value);
    return inner === undefined ? [value] : [value, ...allStrings(inner)];
  }
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => [k, ...allStrings(v)]);
  }
  return [];
}

/** Assert every embedded-JSON leaf in `before` is still embedded JSON in `after`. */
function expectEmbeddedStillParses(before: unknown, after: unknown): void {
  if (typeof before === 'string') {
    const inner = embedded(before);
    if (inner === undefined) return;
    expect(typeof after).toBe('string');
    const reparsed = embedded(after as string);
    expect(reparsed).toBeDefined();
    expectEmbeddedStillParses(inner, reparsed);
    return;
  }
  if (Array.isArray(before)) {
    expect(Array.isArray(after)).toBe(true);
    before.forEach((item, i) => expectEmbeddedStillParses(item, (after as unknown[])[i]));
    return;
  }
  if (typeof before === 'object' && before !== null) {
    for (const [k, v] of Object.entries(before)) {
      expectEmbeddedStillParses(v, (after as Record<string, unknown>)[k]);
    }
  }
}

describe('@no-llm sanitizeStructured', () => {
  it('property: output re-parses, embedded JSON survives, canaries are destroyed, benign URLs are intact', () => {
    fc.assert(
      fc.property(payload, ({ value, urls }) => {
        const result = sanitizeStructured(value, 'authenticated');

        const serialized = JSON.stringify(result.value);
        expect(() => JSON.parse(serialized) as unknown).not.toThrow();
        expectEmbeddedStillParses(value, result.value);
        const strings = allStrings(result.value);
        for (const needle of CANARY_NEEDLES) {
          expect(serialized).not.toContain(needle);
          for (const text of strings) expect(text).not.toContain(needle);
        }
        for (const url of urls) {
          expect(serialized).toContain(url);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('property: never redacts less than the text sanitizer for flat string payloads', () => {
    fc.assert(
      fc.property(mixedLeaf, ({ text }) => {
        const structured = sanitizeStructured(text, 'authenticated');
        const textual = sanitize(text, 'authenticated');

        expect(structured.value).toBe(textual.text);
      }),
      { numRuns: 200 },
    );
  });

  it('replays the run 20260925T130634Z web_search shape without corrupting the inner JSON', () => {
    // The exact failure: a URL ending in `/` immediately before the escaped
    // quote of a double-encoded `content[].text`.
    const inner = JSON.stringify(
      {
        sites: [
          {
            url: 'https://www.autotrader.example/cars-for-sale/new-cars/2026/hyundai/santa-fe/dallas-tx/',
            title: 'New 2026 Hyundai Santa Fe for Sale in Dallas, TX',
          },
        ],
      },
      null,
      2,
    );
    const result = sanitizeStructured(
      { content: [{ type: 'text', text: inner }], details: { ok: true } },
      'authenticated',
    );

    const output = result.value as { content: { text: string }[] };
    const reparsed = JSON.parse(output.content[0]!.text) as { sites: { url: string }[] };
    expect(reparsed.sites[0]!.url).toBe(
      'https://www.autotrader.example/cars-for-sale/new-cars/2026/hyundai/santa-fe/dallas-tx/',
    );
    // Pretty-printed producers keep their layout.
    expect(output.content[0]!.text).toBe(inner);
  });

  it('enforces the byte cap structurally: an oversized payload stays valid JSON and is marked truncated', () => {
    const big = 'x'.repeat(30_000);
    const value = { a: big, b: 'short', nested: JSON.stringify({ body: 'y'.repeat(30_000) }) };

    const result = sanitizeStructured(value, 'authenticated');

    const serialized = JSON.stringify(result.value);
    expect(result.truncated).toBe(true);
    expect(result.transformationsApplied).toContain('truncate');
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(20_480);
    const output = result.value as { a: string; b: string; nested: string };
    expect(output.b).toBe('short');
    expect(output.a.endsWith(STRUCTURED_TRUNCATION_MARKER)).toBe(true);
    expect(() => JSON.parse(output.nested) as unknown).not.toThrow();
  });

  it('truncates multi-byte leaves without splitting a codepoint', () => {
    const value = { text: '€'.repeat(20_000) };

    const result = sanitizeStructured(value, 'authenticated');

    const text = (result.value as { text: string }).text;
    expect(result.truncated).toBe(true);
    expect(text).not.toContain('�');
    expect(text.endsWith(STRUCTURED_TRUNCATION_MARKER)).toBe(true);
  });

  it('drops tail items of a structurally oversized array instead of cutting text', () => {
    const value = { items: Array.from({ length: 20_000 }, (_, i) => i % 7) };

    const result = sanitizeStructured(value, 'authenticated');

    const serialized = JSON.stringify(result.value);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(20_480);
    const items = (result.value as { items: unknown[] }).items;
    expect(items.at(-1)).toMatch(/more items truncated/);
  });

  it('leaves a payload under the cap untouched and unmarked', () => {
    const value = { title: 'Hello', count: 3, ok: true, none: null, list: ['a', 'b'] };

    const result = sanitizeStructured(value, 'authenticated');

    expect(result.value).toEqual(value);
    expect(result.truncated).toBe(false);
    expect(result.transformationsApplied).toEqual([]);
  });

  it('redacts a PII-shaped number leaf to its marker string', () => {
    const result = sanitizeStructured({ card: 4111111111111111, qty: 2 }, 'authenticated');

    expect(result.value).toEqual({ card: '[redacted-credit-card]', qty: 2 });
    expect(result.transformationsApplied).toContain('pii-credit-card-redact');
  });

  it('redacts object keys, as the text path did', () => {
    const result = sanitizeStructured({ [CANARIES.email]: 'owner' }, 'authenticated');

    expect(JSON.stringify(result.value)).not.toContain(CANARIES.email);
  });

  it('honors preserve for values the model already holds', () => {
    const result = sanitizeStructured({ typed: '+1 415 555 0172' }, 'authenticated', {
      preserve: ['+1 415 555 0172'],
    });

    expect(result.value).toEqual({ typed: '+1 415 555 0172' });
  });

  it('applies host overrides from the host hint', () => {
    const result = sanitizeStructured({ text: 'Balance $1,234.56' }, 'authenticated', {
      hostHint: 'https://www.chase.com/account',
    });

    expect(JSON.stringify(result.value)).not.toContain('1,234.56');
    expect(result.transformationsApplied).toContain('host-override-currency-usd');
  });

  it('keeps JSON-scalar string leaves as text', () => {
    const result = sanitizeStructured({ a: '42', b: 'true', c: '"quoted"' }, 'authenticated');

    expect(result.value).toEqual({ a: '42', b: 'true', c: '"quoted"' });
  });

  it('treats a brace-led leaf that is not JSON as plain text', () => {
    const result = sanitizeStructured({ a: `{not json ${CANARIES.ssn}` }, 'authenticated');

    expect(result.value).toEqual({ a: '{not json [redacted-ssn]' });
  });

  it('degrades non-JSON input exactly as the text path does', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;

    const cycleResult = sanitizeStructured(cyclic, 'authenticated');
    const bigintResult = sanitizeStructured(10n, 'authenticated');
    const fnResult = sanitizeStructured(() => 1, 'authenticated');

    expect(cycleResult.value).toBe(sanitize(cyclic, 'authenticated').text);
    expect(cycleResult.transformationsApplied).toContain('truncate');
    expect(bigintResult.value).toBe(sanitize(10n, 'authenticated').text);
    expect(fnResult.value).toBe(sanitize(() => 1, 'authenticated').text);
  });

  it('normalizes through toJSON and drops undefined members like JSON.stringify', () => {
    const at = new Date('2026-10-10T00:00:00.000Z');

    const result = sanitizeStructured({ at, gone: undefined, list: [undefined] }, 'authenticated');

    expect(result.value).toEqual({ at: '2026-10-10T00:00:00.000Z', list: [null] });
  });

  it('bounds embedded-JSON recursion depth', () => {
    let text = JSON.stringify({ leaf: CANARIES.ssn });
    for (let i = 0; i < 12; i += 1) text = JSON.stringify({ wrap: text });

    const result = sanitizeStructured({ text }, 'authenticated');

    expect(JSON.stringify(result.value)).not.toContain(CANARIES.ssn);
  });
});
