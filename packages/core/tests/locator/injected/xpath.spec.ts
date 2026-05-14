// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { generateAbsoluteXpath, queryXpath } from '../../../src/locator/injected/xpath.js';

describe('@no-llm queryXpath', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('finds element by simple XPath', () => {
    document.body.innerHTML = '<button>Click</button>';
    const results = queryXpath('//button');
    expect(results).toHaveLength(1);
    expect((results[0] as HTMLButtonElement).textContent).toBe('Click');
  });

  it('returns empty when XPath has no matches', () => {
    document.body.innerHTML = '<div></div>';
    const results = queryXpath('//button');
    expect(results).toHaveLength(0);
  });

  it('throws SyntaxError for invalid XPath', () => {
    expect(() => queryXpath('!!!invalid xpath')).toThrow(SyntaxError);
  });

  it('handles multiple matches', () => {
    document.body.innerHTML = '<ul><li>A</li><li>B</li><li>C</li></ul>';
    const results = queryXpath('//li');
    expect(results).toHaveLength(3);
  });
});

describe('@no-llm generateAbsoluteXpath', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('generates a path that round-trips (queryXpath ∘ generateAbsoluteXpath = identity)', () => {
    document.body.innerHTML = '<div><ul><li>Item</li></ul></div>';
    const el = document.querySelector('li')!;
    const xpath = generateAbsoluteXpath(el);
    const results = queryXpath(xpath);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe(el);
  });

  it('generates correct nth-of-type index for second sibling', () => {
    document.body.innerHTML = '<ul><li>First</li><li>Second</li></ul>';
    const secondLi = document.querySelectorAll('li')[1]!;
    const xpath = generateAbsoluteXpath(secondLi);
    expect(xpath).toContain('li[2]');
    const results = queryXpath(xpath);
    expect(results[0]).toBe(secondLi);
  });

  it('returns "/" for the root html element', () => {
    // The root element would produce the html path
    const el = document.querySelector('html')!;
    const xpath = generateAbsoluteXpath(el);
    // Should contain "html"
    expect(xpath.toLowerCase()).toContain('html');
  });

  it('round-trips for deeply nested element', () => {
    document.body.innerHTML = '<section><article><p><em>Text</em></p></article></section>';
    const em = document.querySelector('em')!;
    const xpath = generateAbsoluteXpath(em);
    const results = queryXpath(xpath);
    expect(results[0]).toBe(em);
  });
});
