// @vitest-environment jsdom

import { describe, expect, it, beforeEach } from 'vitest';

import { getAccessibleName, getRole } from '../../../src/locator/injected/role.js';

function makeElement(html: string): Element {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container.firstElementChild!;
}

describe('@no-llm getRole', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns button for <button>', () => {
    const el = makeElement('<button>Click</button>');
    expect(getRole(el)).toBe('button');
  });

  it('returns link for <a href>', () => {
    const el = makeElement('<a href="/">Home</a>');
    expect(getRole(el)).toBe('link');
  });

  it('returns null for <a> without href', () => {
    const el = makeElement('<a>Not a link</a>');
    expect(getRole(el)).toBeNull();
  });

  it('returns textbox for <input type="text">', () => {
    const el = makeElement('<input type="text">');
    expect(getRole(el)).toBe('textbox');
  });

  it('returns textbox for <input> without type (defaults to text)', () => {
    const el = makeElement('<input>');
    expect(getRole(el)).toBe('textbox');
  });

  it('returns checkbox for <input type="checkbox">', () => {
    const el = makeElement('<input type="checkbox">');
    expect(getRole(el)).toBe('checkbox');
  });

  it('returns radio for <input type="radio">', () => {
    const el = makeElement('<input type="radio">');
    expect(getRole(el)).toBe('radio');
  });

  it('returns null for <input type="hidden">', () => {
    const el = makeElement('<input type="hidden">');
    expect(getRole(el)).toBeNull();
  });

  it('returns heading for <h1>-<h6>', () => {
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      const el = makeElement(`<${tag}>Title</${tag}>`);
      expect(getRole(el)).toBe('heading');
    }
  });

  it('returns navigation for <nav>', () => {
    const el = makeElement('<nav></nav>');
    expect(getRole(el)).toBe('navigation');
  });

  it('uses explicit role attribute when valid', () => {
    const el = makeElement('<div role="button">Click</div>');
    expect(getRole(el)).toBe('button');
  });

  it('ignores invalid role attribute and falls back to implicit', () => {
    const el = makeElement('<button role="notarole">Click</button>');
    expect(getRole(el)).toBe('button');
  });

  it('first token in role attribute wins for multi-token', () => {
    const el = makeElement('<div role="button tab">Click</div>');
    expect(getRole(el)).toBe('button');
  });

  it('returns textbox for <textarea>', () => {
    const el = makeElement('<textarea></textarea>');
    expect(getRole(el)).toBe('textbox');
  });

  it('returns null for <div> with no role', () => {
    const el = makeElement('<div></div>');
    expect(getRole(el)).toBeNull();
  });
});

describe('@no-llm getAccessibleName', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns inner text for <button>', () => {
    const el = makeElement('<button>Sign in</button>');
    expect(getAccessibleName(el)).toBe('Sign in');
  });

  it('returns aria-label when present', () => {
    const el = makeElement('<button aria-label="Close dialog">X</button>');
    expect(getAccessibleName(el)).toBe('Close dialog');
  });

  it('returns aria-labelledby text', () => {
    document.body.innerHTML =
      '<span id="lbl">Save</span><div role="button" aria-labelledby="lbl">ignored</div>';
    const btn = document.querySelector('[role="button"]')!;
    expect(getAccessibleName(btn)).toBe('Save');
  });

  it('aria-labelledby wins over aria-label', () => {
    document.body.innerHTML =
      '<span id="lbl">From labelledby</span><button aria-labelledby="lbl" aria-label="From aria-label">X</button>';
    const btn = document.querySelector('button')!;
    expect(getAccessibleName(btn)).toBe('From labelledby');
  });

  it('aria-label wins over native label', () => {
    document.body.innerHTML =
      '<label for="inp">Native label</label><input id="inp" aria-label="Override label">';
    const inp = document.querySelector('input')!;
    expect(getAccessibleName(inp)).toBe('Override label');
  });

  it('returns native label text via for/id association', () => {
    document.body.innerHTML =
      '<label for="email">Email address</label><input id="email" type="text">';
    const inp = document.querySelector('input')!;
    expect(getAccessibleName(inp)).toBe('Email address');
  });

  it('returns placeholder when no label is present', () => {
    const el = makeElement('<input type="text" placeholder="Enter email">');
    expect(getAccessibleName(el)).toBe('Enter email');
  });

  it('concatenates multiple aria-labelledby ids', () => {
    document.body.innerHTML =
      '<span id="a">First</span><span id="b">Last</span><input aria-labelledby="a b">';
    const inp = document.querySelector('input')!;
    expect(getAccessibleName(inp)).toBe('First Last');
  });
});
