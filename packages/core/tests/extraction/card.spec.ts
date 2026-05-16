import { describe, expect, it } from 'vitest';

import { renderJson, renderMarkdown, renderTerminal } from '../../src/extraction/card.js';
import type { AskCard } from '../../src/extraction/types.js';

const cards: AskCard[] = [
  {
    url: 'https://example.com/one',
    title: 'Card One',
    source: 'example.com',
    fetchedAt: '2026-05-11T10:14:00.000Z',
    publishedAt: '2026-05-11T09:00:00.000Z',
    summary: 'This is the first summary sentence. This is the second sentence.',
    summaryKind: 'rule-based',
    quotedSnippet: 'First quoted snippet.',
    tags: ['ai', 'news'],
    notice: null,
  },
  {
    url: 'https://example.com/two',
    title: 'Card Two',
    source: 'example.com',
    fetchedAt: '2026-05-11T10:14:01.000Z',
    publishedAt: null,
    summary: '',
    summaryKind: 'fallback-lede',
    quotedSnippet: 'Second quoted snippet.',
    tags: ['ai'],
    notice: 'fetch timed out',
  },
];

describe('@no-llm extraction/card', () => {
  it('renders terminal output as bordered cards', () => {
    const output = renderTerminal(cards, { color: false, width: 70 });
    expect(output).toMatchSnapshot();
  });

  it('renders stable json output', () => {
    expect(renderJson(cards)).toMatchSnapshot();
  });

  it('renders markdown report sections', () => {
    const output = renderMarkdown(cards);
    expect(output).toMatchSnapshot();
  });
});
