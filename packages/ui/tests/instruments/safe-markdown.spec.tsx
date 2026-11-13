// @no-llm
/**
 * SafeMarkdown (FEAT-066 TASK-005): untrusted Markdown renders inert — no
 * raw HTML, no script URLs, no image requests — and citation tokens become
 * chips only when they resolve.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  SafeMarkdown,
  isSafeExternalHref,
  parseCitationRef,
  type CitationContext,
  type CitationRef,
} from '../../src/instruments/SafeMarkdown.js';
import { expectNoAxeViolations } from '../support/axe.js';

function context(sources: number[], actions: string[] = []): CitationContext {
  return {
    resolves: (ref: CitationRef) =>
      ref.kind === 'source' ? sources.includes(ref.n) : actions.includes(ref.id),
    render: (ref: CitationRef) => (
      <button type="button" data-chip={ref.kind === 'source' ? String(ref.n) : ref.id}>
        {ref.kind === 'source' ? `Source ${String(ref.n)}` : `Action ${ref.id}`}
      </button>
    ),
  };
}

function chips(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-chip]')].map(
    (node) => node.getAttribute('data-chip')!,
  );
}

describe('SafeMarkdown', () => {
  it('renders GFM: headings, lists, tables and emphasis', () => {
    const { container } = render(
      <SafeMarkdown>
        {'# Title\n\n- **one**\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'}
      </SafeMarkdown>,
    );
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('one');
  });

  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">click</a>',
    '<iframe src="https://evil.example"></iframe>',
  ])('renders raw HTML %j inert', (html) => {
    const { container } = render(<SafeMarkdown>{`before ${html} after`}</SafeMarkdown>);
    expect(container.querySelector('script, img, iframe, a')).toBeNull();
    expect(container.innerHTML).not.toMatch(/onerror|javascript:/iu);
  });

  it('renders a markdown javascript: link as plain text', () => {
    const { container } = render(<SafeMarkdown>{'[click](javascript:alert(1))'}</SafeMarkdown>);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('click');
  });

  it.each([
    '/runs/1',
    'relative/page',
    'mailto:a@example.com',
    'data:text/html,hi',
    'ftp://x.example',
  ])('renders the non-http link %j as text', (href) => {
    const { container } = render(<SafeMarkdown>{`[label](${href})`}</SafeMarkdown>);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('label');
  });

  it('gives an external link noopener noreferrer and a new tab', () => {
    render(<SafeMarkdown>{'[docs](https://example.com/docs)'}</SafeMarkdown>);
    const link = screen.getByRole('link', { name: /docs/u });
    expect(link.getAttribute('href')).toBe('https://example.com/docs');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('never loads a markdown image: it renders as its alt text', () => {
    const { container } = render(
      <SafeMarkdown>{'![tracking pixel](https://tracker.example/p.png)'}</SafeMarkdown>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('tracking pixel');
  });

  it('turns resolving [n] and [A<n>] tokens into chips', () => {
    const { container } = render(
      <SafeMarkdown citations={context([1, 2], ['A1'])}>
        {'Prices rose [1][2] after the fill [A1].'}
      </SafeMarkdown>,
    );
    expect(chips(container)).toEqual(['1', '2', 'A1']);
    expect(container.textContent).toBe('Prices rose Source 1Source 2 after the fill Action A1.');
  });

  it('leaves a token that does not resolve as literal text', () => {
    const { container } = render(
      <SafeMarkdown citations={context([1])}>{'See [3] and [A9] and [1].'}</SafeMarkdown>,
    );
    expect(chips(container)).toEqual(['1']);
    expect(container.textContent).toBe('See [3] and [A9] and Source 1.');
  });

  it('leaves tokens literal without a citation context', () => {
    const { container } = render(<SafeMarkdown>{'Claim [1].'}</SafeMarkdown>);
    expect(container.textContent).toBe('Claim [1].');
  });

  it('never turns a token inside a link or code into a chip', () => {
    const { container } = render(
      <SafeMarkdown citations={context([1])}>
        {'[see [1]](https://e.example) and `[1]`'}
      </SafeMarkdown>,
    );
    expect(chips(container)).toEqual([]);
  });

  it.each([
    ['3', { kind: 'source', n: 3 }],
    ['A12', { kind: 'action', id: 'A12' }],
    ['0', null],
    ['A0', null],
    ['x', null],
  ])('parses the reference %j', (raw, expected) => {
    expect(parseCitationRef(raw)).toEqual(expected);
  });

  it.each([
    ['https://e.example', true],
    ['http://e.example/x', true],
    ['//e.example', false],
    ['/x', false],
    [undefined, false],
  ])('treats %j as a safe external href: %s', (href, expected) => {
    expect(isSafeExternalHref(href)).toBe(expected);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <SafeMarkdown citations={context([1])}>
        {'# H\n\nText [1] with [a link](https://e.example).'}
      </SafeMarkdown>,
    );
    await expectNoAxeViolations(container);
  });
});
