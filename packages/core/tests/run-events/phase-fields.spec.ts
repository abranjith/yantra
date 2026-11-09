// @no-llm
import { PHASE_QUERY_MAX, PHASE_URL_MAX, RunEvent } from '@yantra/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ProcessedSource } from '../../src/extraction/source-processor.js';
import { mirrorOf } from '../../src/run-events/mirroring-event-bus.js';
import {
  asToken,
  boundedQuery,
  budgetDimensions,
  capText,
  displayUrl,
  sourceFetchedEvent,
  stripControl,
} from '../../src/run-events/phase-fields.js';

import { AT } from './support.js';

const CANARY = 'sk-CANARY0123456789abcdefghijklmn';

describe('@no-llm displayUrl', () => {
  it('keeps origin and path, dropping userinfo, query and fragment', () => {
    expect(displayUrl('https://user:pass@example.com:8443/a/b?token=abc&x=1#frag')).toBe(
      'https://example.com:8443/a/b',
    );
  });

  it('redacts a credential-shaped path to <origin>/[redacted]', () => {
    expect(displayUrl(`https://api.example.com/v1/${CANARY}/items`)).toBe(
      'https://api.example.com/[redacted]',
    );
    expect(displayUrl('https://example.com/reset/ghp_abcdefghijklmnop')).toBe(
      'https://example.com/[redacted]',
    );
  });

  it('redacts a percent-encoded credential-shaped path too', () => {
    expect(displayUrl(`https://example.com/x/${encodeURIComponent(CANARY)}%2F`)).toBe(
      'https://example.com/[redacted]',
    );
  });

  it('caps the result at 300 characters', () => {
    const url = displayUrl(`https://example.com/${'p'.repeat(1000)}`);

    expect(url.length).toBe(PHASE_URL_MAX);
    expect(url.endsWith('…')).toBe(true);
  });

  it('reports anything that is not an http(s) URL as [invalid url]', () => {
    expect(displayUrl('not a url')).toBe('[invalid url]');
    expect(displayUrl('javascript:alert(1)')).toBe('[invalid url]');
    expect(displayUrl('file:///etc/passwd')).toBe('[invalid url]');
    expect(displayUrl('')).toBe('[invalid url]');
  });

  it('never contains the input’s query string or fragment (property)', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: true, withFragments: true }),
        fc.string({ minLength: 6, maxLength: 20 }).filter((s) => /^[a-z0-9]+$/i.test(s)),
        (base, secret) => {
          const url = `${base.split(/[?#]/u)[0]}?q=${secret}#${secret}`;
          const shown = displayUrl(url);
          expect(shown).not.toContain(`q=${secret}`);
          expect(shown).not.toContain('?');
          expect(shown).not.toContain('#');
          expect(shown.length).toBeLessThanOrEqual(PHASE_URL_MAX);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('@no-llm boundedQuery', () => {
  it('replaces a credential-shaped token with its placeholder', () => {
    const shown = boundedQuery(`latest news ${CANARY} today`);

    expect(shown).not.toContain(CANARY);
    expect(shown).toBe('latest news {{user:api_key:1}} today');
  });

  it('strips control characters and collapses whitespace', () => {
    expect(boundedQuery('a\u001b[2Jb\t\tc\n')).toBe('a [2Jb c');
  });

  it('caps at 200 characters with an ellipsis', () => {
    const shown = boundedQuery('q'.repeat(500));

    expect(shown).toHaveLength(PHASE_QUERY_MAX);
    expect(shown.endsWith('…')).toBe(true);
  });

  it('never shows a malformed marker raw', () => {
    expect(boundedQuery('find @{secret unclosed')).toBe('[not shown]');
  });

  it('always yields a schema-valid search_completed query (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (query) => {
        const event = {
          kind: 'search_completed',
          hop_index: null,
          provider: 'duckduckgo',
          query: boundedQuery(query),
          result_count: 0,
          cached: false,
          at: AT,
        };
        expect(RunEvent.safeParse(event).success).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe('@no-llm small helpers', () => {
  it('capText never splits a surrogate pair', () => {
    const text = `${'a'.repeat(8)}😀😀`;

    expect(capText(text, 10)).toBe(`${'a'.repeat(8)}…`);
    expect(capText('short', 10)).toBe('short');
  });

  it('stripControl removes C0 and C1 controls', () => {
    expect(stripControl('a\u0000b\u0085c\u007fd')).toBe('a b c d');
  });

  it('asToken makes a snake_case token or `unknown`', () => {
    expect(asToken('DuckDuckGo-HTML')).toBe('duckduckgo_html');
    expect(asToken('123')).toBe('unknown');
    expect(asToken('x'.repeat(100))).toHaveLength(48);
  });

  it('budgetDimensions reports research budget use against its limits', () => {
    expect(
      budgetDimensions(
        {
          hopsUsed: 2,
          hopsRemaining: 1,
          sourcesUsed: 5,
          sourcesRemaining: 19,
          llmCallsUsed: 0,
          llmCallsRemaining: 4,
          elapsedMs: 1500,
          wallClockRemainingMs: 98_500,
        },
        { maxHops: 3, maxSources: 24, maxLlmCalls: 4, maxWallClockMs: 100_000 },
      ),
    ).toEqual([
      { name: 'hops', used: 2, limit: 3, unit: 'count' },
      { name: 'sources', used: 5, limit: 24, unit: 'count' },
      { name: 'llm_calls', used: 0, limit: 4, unit: 'count' },
      { name: 'elapsed', used: 1500, limit: 100_000, unit: 'ms' },
    ]);
  });
});

describe('@no-llm sourceFetchedEvent', () => {
  const meta = { hopIndex: 2, sourceIndex: 3, durationMs: 40, at: AT };
  const failure = (stage: NonNullable<ProcessedSource['failure']>['stage']): ProcessedSource =>
    ({
      rank: 0,
      doc: null,
      failure: { url: 'u', host: 'h', stage, reason: 'r' },
      fetchMode: null,
    }) as ProcessedSource;

  it.each([
    ['fetch', 'failed'],
    ['extract', 'failed'],
    ['blocked', 'blocked'],
    ['budget', 'skipped'],
    ['policy', 'skipped'],
  ] as const)('maps a %s failure to %s with its stage as failure_class', (stage, status) => {
    const event = sourceFetchedEvent('https://example.com/a?k=v', failure(stage), meta);

    expect(event).toEqual({
      kind: 'source_fetched',
      hop_index: 2,
      source_index: 3,
      url: 'https://example.com/a',
      status,
      failure_class: stage,
      duration_ms: 40,
      at: AT,
    });
    expect(RunEvent.safeParse(event).success).toBe(true);
  });

  it('maps a fetched document to ok and an unprocessed source to failed', () => {
    const ok = { rank: 0, doc: {}, failure: null, fetchMode: 'http' } as unknown as ProcessedSource;

    expect(sourceFetchedEvent('https://e.com/x', ok, meta)).toMatchObject({
      status: 'ok',
      failure_class: null,
    });
    expect(sourceFetchedEvent('https://e.com/x', null, meta)).toMatchObject({
      status: 'failed',
      failure_class: 'unexpected',
    });
  });
});

describe('@no-llm mirrorOf', () => {
  it('redacts research hop queries and leaves every other event untouched', () => {
    const hop = {
      kind: 'research_hop_completed',
      task_id: 't',
      at: AT,
      hop_index: 1,
      queries: [`find ${CANARY}`, 'plain'],
      docs_fetched: 1,
      docs_kept: 1,
      coverage: 0.5,
      coverage_delta: 0.5,
    } as const;
    const started = { kind: 'task_started', task_id: 't', at: AT } as const;

    expect(mirrorOf(hop)).toEqual({ ...hop, queries: ['find {{user:api_key:1}}', 'plain'] });
    expect(mirrorOf(started)).toBe(started);
  });
});
