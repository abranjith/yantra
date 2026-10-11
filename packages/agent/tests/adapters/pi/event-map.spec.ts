import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import { createDefaultPiEventMapContext, mapPiEvent } from '../../../src/adapters/pi/event-map.js';

const RESULTS_URL =
  'https://www.autotrader.example/cars-for-sale/new-cars/2026/hyundai/santa-fe/dallas-tx/';

/**
 * The `web_search` end-record shape from run `20260925T130634Z`: the
 * middleware's compact `modelText` (a JSON document) inside Pi's
 * `content[].text`, so the URL's closing quote is a JSON escape (`/\"`) once
 * the event is serialized.
 */
function webSearchEnd(): AgentSessionEvent {
  const modelText = JSON.stringify({
    query: '2026 hyundai santa fe calligraphy dallas',
    sites: [
      {
        n: 1,
        url: RESULTS_URL,
        title: 'New 2026 Hyundai Santa Fe for Sale in Dallas, TX',
        published_at: null,
        excerpt: 'Calligraphy (44) 50,265 MSRP$50,255 Dealer Fees Included',
        text: `Listings near you. Contact jane.dealer@example.com or see ${RESULTS_URL}`,
      },
    ],
    more_results: [
      { url: 'https://news.example.com/posts/10160610212631779/', title: 'x', snippet: 'y' },
    ],
    failures: [],
    note: 'These sites are recorded as your sources automatically.',
  });
  return {
    type: 'tool_execution_end',
    toolCallId: 'call-7',
    toolName: 'web_search',
    result: {
      content: [{ type: 'text', text: modelText }],
      details: { provider: 'duckduckgo', fetched: 1, failed: 0, more_results: 1, captures: 0 },
      status: 'ok',
    },
    isError: false,
  } as AgentSessionEvent;
}

describe('@no-llm Pi event map — structural payload sanitization', () => {
  it('a web_search end record stays structured with a parseable content[0].text (G8 regression)', () => {
    const ctx = createDefaultPiEventMapContext();

    const [event] = mapPiEvent(webSearchEnd(), ctx);

    expect(event?.type).toBe('tool_finished');
    const output = (event as { output: unknown }).output as {
      content: { type: string; text: string }[];
      status: string;
      details: { provider: string };
    };
    expect(typeof output).toBe('object');
    expect(output.status).toBe('ok');
    expect(output.details.provider).toBe('duckduckgo');
    const inner = JSON.parse(output.content[0]!.text) as {
      sites: { url: string; text: string }[];
      more_results: { url: string }[];
    };
    expect(inner.sites[0]!.url).toBe(RESULTS_URL);
    // No false rewrite adds a slash to a URL that already ends in one.
    expect(inner.more_results[0]!.url).toBe('https://news.example.com/posts/10160610212631779/');
    expect(inner.sites[0]!.text).not.toContain('jane.dealer@example.com');
  });

  it('tool inputs are sanitized structurally too', () => {
    const ctx = createDefaultPiEventMapContext();

    const [event] = mapPiEvent(
      {
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'web_fetch',
        args: { url: 'https://example.com/a?token=SECRETTOKEN123' },
      } as AgentSessionEvent,
      ctx,
    );

    expect((event as { input: unknown }).input).toEqual({ url: 'https://example.com/a' });
  });

  it('a string payload stays a string', () => {
    const ctx = createDefaultPiEventMapContext();

    expect(ctx.sanitizePayload('ok sk-abcdefghijklmnopqrstu')).toBe('ok [redacted-api-key]');
  });

  it('an oversized result stays structured and parseable instead of degrading to text', () => {
    const ctx = createDefaultPiEventMapContext();
    const modelText = JSON.stringify({ sites: [{ url: RESULTS_URL, text: 'z'.repeat(60_000) }] });

    const output = ctx.sanitizePayload({ content: [{ type: 'text', text: modelText }] }) as {
      content: { text: string }[];
    };

    expect(typeof output).toBe('object');
    const inner = JSON.parse(output.content[0]!.text) as { sites: { url: string }[] };
    expect(inner.sites[0]!.url).toBe(RESULTS_URL);
  });
});
