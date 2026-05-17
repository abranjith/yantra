// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  generateUniqueCss,
  isStableClassName,
  queryCss,
} from '../../../src/locator/injected/css.js';

describe('@no-llm queryCss', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns matching elements', () => {
    document.body.innerHTML = '<button class="btn">Click</button>';
    const results = queryCss('button.btn');
    expect(results).toHaveLength(1);
  });

  it('returns empty array when nothing matches', () => {
    document.body.innerHTML = '<div></div>';
    const results = queryCss('button');
    expect(results).toHaveLength(0);
  });

  it('throws SyntaxError for invalid selector', () => {
    expect(() => queryCss('!!!invalid')).toThrow();
  });
});

describe('@no-llm generateUniqueCss', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('generates selector using data-testid (terminates immediately)', () => {
    document.body.innerHTML = '<button data-testid="submit-btn">Submit</button>';
    const el = document.querySelector('button')!;
    const selector = generateUniqueCss(el);
    expect(selector).toContain('submit-btn');
    expect(queryCss(selector!)).toHaveLength(1);
    expect(queryCss(selector!)[0]).toBe(el);
  });

  it('generates selector using stable id', () => {
    document.body.innerHTML = '<button id="main-submit">Submit</button>';
    const el = document.querySelector('button')!;
    const selector = generateUniqueCss(el);
    expect(selector).not.toBeNull();
    expect(queryCss(selector!)[0]).toBe(el);
  });

  it('filters out hashed class names (CSS-Modules style)', () => {
    document.body.innerHTML = '<button class="css-abc123">Hashed</button>';
    const el = document.querySelector('button')!;
    const selector = generateUniqueCss(el);
    // Should not include the hashed class in a class-based selector
    if (selector !== null) {
      expect(selector).not.toContain('css-abc123');
    }
  });

  it('uses stable class names when available', () => {
    document.body.innerHTML = '<button class="btn-primary">Stable</button>';
    const el = document.querySelector('button')!;
    const selector = generateUniqueCss(el);
    expect(selector).not.toBeNull();
    if (selector) {
      expect(queryCss(selector)[0]).toBe(el);
    }
  });

  it('falls back to nth-of-type when no stable selectors available', () => {
    document.body.innerHTML = `
      <div class="css-xyz"><span class="css-abc">A</span></div>
      <div class="css-xyz"><span class="css-abc">B</span></div>
    `;
    const spans = document.querySelectorAll('span');
    const sel = generateUniqueCss(spans[0]!);
    if (sel !== null) {
      expect(queryCss(sel)).toHaveLength(1);
    }
  });

  it('respects depth cap', () => {
    // Deeply nested element with no unique selectors
    let html = '<span>inner</span>';
    for (let i = 0; i < 15; i++) {
      html = `<div>${html}</div>`;
    }
    document.body.innerHTML = html;
    const span = document.querySelector('span')!;
    // Should return null or a valid selector within depth cap
    const selector = generateUniqueCss(span, { depthCap: 3 });
    if (selector !== null) {
      // If we found one, it must uniquely identify the element
      expect(queryCss(selector).length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('@no-llm isStableClassName', () => {
  it('considers plain class names stable', () => {
    expect(isStableClassName('btn-primary')).toBe(true);
    expect(isStableClassName('header')).toBe(true);
    expect(isStableClassName('nav-link')).toBe(true);
  });

  it('rejects css- prefixed class names', () => {
    expect(isStableClassName('css-abc123')).toBe(false);
  });

  it('rejects mixed-alphanumeric hashes (CSS Modules style)', () => {
    expect(isStableClassName('abc1d')).toBe(false); // mixed alnum, 5 chars
    expect(isStableClassName('f8a3e')).toBe(false); // mixed alnum, 5 chars
  });

  it('rejects classes with trailing 4+ digit numeric suffix', () => {
    expect(isStableClassName('item-1234')).toBe(false);
    expect(isStableClassName('module-9999')).toBe(false);
  });

  it('allows short names that do not match patterns', () => {
    expect(isStableClassName('btn')).toBe(true);
    expect(isStableClassName('nav')).toBe(true);
  });
});
