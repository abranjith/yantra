// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { resolveRelative } from '../../../src/locator/injected/relative.js';

describe('@no-llm resolveRelative', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('next-sibling: finds the first matching sibling after anchor', () => {
    document.body.innerHTML = `
      <div>
        <label id="anchor">Username</label>
        <input type="text" id="target">
        <input type="text" id="not-target">
      </div>
    `;
    const anchor = document.getElementById('anchor')!;
    const results = resolveRelative(anchor, 'next-sibling');
    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe('target');
  });

  it('previous-sibling: finds the first matching sibling before anchor', () => {
    document.body.innerHTML = `
      <div>
        <button id="back">Back</button>
        <button id="anchor">Next</button>
      </div>
    `;
    const anchor = document.getElementById('anchor')!;
    const results = resolveRelative(anchor, 'previous-sibling');
    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe('back');
  });

  it('following: finds elements after anchor in document order', () => {
    document.body.innerHTML = `
      <p id="anchor">Intro</p>
      <h2>Section</h2>
      <p>Body</p>
    `;
    const anchor = document.getElementById('anchor')!;
    const results = resolveRelative(anchor, 'following');
    expect(results.length).toBeGreaterThan(0);
    // anchor should not be in results
    expect(results.includes(anchor)).toBe(false);
  });

  it('preceding: finds elements before anchor in document order', () => {
    document.body.innerHTML = `
      <p id="first">First</p>
      <p id="anchor">Anchor</p>
    `;
    const anchor = document.getElementById('anchor')!;
    const results = resolveRelative(anchor, 'preceding');
    expect(results.length).toBeGreaterThan(0);
    expect(results.find((el) => (el as HTMLElement).id === 'first')).toBeTruthy();
    expect(results.includes(anchor)).toBe(false);
  });

  it('ancestor: finds the closest ancestor matching role filter', () => {
    document.body.innerHTML = `
      <nav>
        <ul>
          <li><a href="/" id="anchor">Home</a></li>
        </ul>
      </nav>
    `;
    const anchor = document.getElementById('anchor')!;
    const results = resolveRelative(anchor, 'ancestor', 'navigation');
    expect(results).toHaveLength(1);
    expect(results[0]!.tagName).toBe('NAV');
  });

  it('descendant: finds the first matching descendant', () => {
    document.body.innerHTML = `
      <form id="anchor">
        <label>Email</label>
        <input type="email" id="target">
      </form>
    `;
    const anchor = document.getElementById('anchor')!;
    const results = resolveRelative(anchor, 'descendant', 'textbox');
    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe('target');
  });

  it('labeled-by: finds input controlled by anchor label', () => {
    document.body.innerHTML = `
      <label for="pw" id="anchor">Password</label>
      <input id="pw" type="password">
    `;
    const anchor = document.getElementById('anchor')!;
    const results = resolveRelative(anchor, 'labeled-by');
    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe('pw');
  });

  it('labeled-by with implicit label: finds wrapped input', () => {
    document.body.innerHTML = `
      <label id="anchor">Remember me <input type="checkbox" id="cb"></label>
    `;
    const anchor = document.getElementById('anchor')!;
    const results = resolveRelative(anchor, 'labeled-by');
    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe('cb');
  });

  it('next-sibling with role filter skips non-matching siblings', () => {
    document.body.innerHTML = `
      <div>
        <span id="anchor">Label</span>
        <div>Skipped (not textbox)</div>
        <input type="text" id="target">
      </div>
    `;
    const anchor = document.getElementById('anchor')!;
    const results = resolveRelative(anchor, 'next-sibling', 'textbox');
    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe('target');
  });
});
