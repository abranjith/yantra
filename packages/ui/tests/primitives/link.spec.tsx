import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { classifyHref, Link, type HrefKind } from '../../src/primitives/Link.js';

describe('@no-llm Drshya Link', () => {
  describe('classifyHref', () => {
    it.each<[string, HrefKind]>([
      ['https://x.test', 'external'],
      ['http://x.test/path?q=1', 'external'],
      ['HTTPS://X.TEST', 'external'],
      ['//evil.test', 'external'],
      ['/runs/1', 'internal'],
      ['#summary', 'internal'],
      ['?entry=button', 'internal'],
      ['runs/1', 'internal'],
      ['javascript:alert(1)', 'unsafe'],
      ['JaVaScRiPt:alert(1)', 'unsafe'],
      [' javascript:alert(1)', 'unsafe'],
      ['java\tscript:alert(1)', 'unsafe'],
      ['java\nscript:alert(1)', 'unsafe'],
      ['data:text/html,<script>alert(1)</script>', 'unsafe'],
      ['file:///etc/passwd', 'unsafe'],
      ['blob:https://x.test/0f8a', 'unsafe'],
      ['mailto:someone@x.test', 'unsafe'],
      ['vbscript:msgbox(1)', 'unsafe'],
      ['', 'unsafe'],
      ['   ', 'unsafe'],
      ['http://[::1', 'unsafe'],
      ['https://', 'unsafe'],
    ])('classifies %j as %s', (href, kind) => {
      expect(classifyHref(href)).toBe(kind);
    });

    it('treats backslash paths the way browsers do (protocol-relative)', () => {
      expect(classifyHref('/\\evil.test')).toBe('external');
      expect(classifyHref('\\\\evil.test')).toBe('external');
    });
  });

  it('opens an external link in a new context with noopener noreferrer, and says so', () => {
    render(<Link href="https://x.test/returns">Return policy</Link>);

    const link = screen.getByRole('link', { name: /Return policy/u });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('href')).toBe('https://x.test/returns');
    expect(link.textContent).toContain('(opens in a new tab)');
    expect(link.querySelector('svg[data-icon="action.openExternal"]')).not.toBeNull();
  });

  it('keeps an internal link in the app', () => {
    render(<Link href="/runs/42">Run 42</Link>);

    const link = screen.getByRole('link', { name: 'Run 42' });
    expect(link.getAttribute('href')).toBe('/runs/42');
    expect(link.hasAttribute('target')).toBe(false);
    expect(link.textContent).not.toContain('opens in a new tab');
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', ''])(
    'renders %j as inert text, never an anchor',
    (href) => {
      const { container } = render(<Link href={href}>Not a link</Link>);

      expect(container.querySelector('a')).toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.getByText('Not a link').className).toBe('text-ink-2');
    },
  );
});
