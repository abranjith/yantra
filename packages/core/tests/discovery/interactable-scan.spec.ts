// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scanInteractablesInPage } from '../../src/discovery/interactable-scan.js';

function makeVisibleRect(top = 10): DOMRect {
  return {
    top,
    left: 10,
    bottom: top + 40,
    right: 110,
    width: 100,
    height: 40,
    x: 10,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function stubVisible(el: Element, top = 10): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(makeVisibleRect(top));
}

describe('@no-llm scanInteractablesInPage', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      visibility: 'visible',
      display: 'block',
    } as CSSStyleDeclaration);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds a button by tag and text content', () => {
    const btn = document.createElement('button');
    btn.textContent = 'Search';
    document.body.appendChild(btn);
    stubVisible(btn);

    const results = scanInteractablesInPage();
    expect(results).toEqual([
      { role: 'button', name: 'Search', kind: 'button', disabled: false, top: 10, visible: true },
    ]);
  });

  it('finds a link with an href and derives role=link', () => {
    const a = document.createElement('a');
    a.href = 'https://example.com';
    a.textContent = 'Home';
    document.body.appendChild(a);
    stubVisible(a);

    const results = scanInteractablesInPage();
    expect(results).toEqual([
      expect.objectContaining({ role: 'link', name: 'Home', kind: 'link' }),
    ]);
  });

  it('ignores an <a> with no href (not a real interactable)', () => {
    const a = document.createElement('a');
    a.textContent = 'Not a link';
    document.body.appendChild(a);
    stubVisible(a);

    expect(scanInteractablesInPage()).toEqual([]);
  });

  it('derives textbox role for a plain text input and its placeholder as name', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search products';
    document.body.appendChild(input);
    stubVisible(input);

    const results = scanInteractablesInPage();
    expect(results).toEqual([
      expect.objectContaining({ role: 'textbox', name: 'Search products', kind: 'input' }),
    ]);
  });

  it('derives checkbox/radio roles from input[type]', () => {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', 'Accept terms');
    document.body.appendChild(checkbox);
    stubVisible(checkbox);

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.setAttribute('aria-label', 'Option A');
    document.body.appendChild(radio);
    stubVisible(radio, 60);

    const results = scanInteractablesInPage();
    expect(results.find((r) => r.role === 'checkbox')?.name).toBe('Accept terms');
    expect(results.find((r) => r.role === 'radio')?.name).toBe('Option A');
  });

  it('derives combobox role for select and marks it disabled', () => {
    const select = document.createElement('select');
    select.disabled = true;
    select.setAttribute('aria-label', 'Country');
    document.body.appendChild(select);
    stubVisible(select);

    const results = scanInteractablesInPage();
    expect(results).toEqual([
      expect.objectContaining({
        role: 'combobox',
        kind: 'select',
        disabled: true,
        name: 'Country',
      }),
    ]);
  });

  it('resolves the accessible name via aria-labelledby', () => {
    const label = document.createElement('span');
    label.id = 'lbl1';
    label.textContent = 'Submit order';
    document.body.appendChild(label);
    const btn = document.createElement('button');
    btn.setAttribute('aria-labelledby', 'lbl1');
    document.body.appendChild(btn);
    stubVisible(btn);

    const results = scanInteractablesInPage();
    expect(results[0]?.name).toBe('Submit order');
  });

  it('resolves the accessible name via a <label for="id">', () => {
    const label = document.createElement('label');
    label.setAttribute('for', 'field1');
    label.textContent = 'Email address';
    document.body.appendChild(label);
    const input = document.createElement('input');
    input.id = 'field1';
    document.body.appendChild(input);
    stubVisible(input);

    const results = scanInteractablesInPage();
    expect(results[0]?.name).toBe('Email address');
  });

  it('resolves the accessible name via a wrapping <label>', () => {
    const label = document.createElement('label');
    label.textContent = 'Remember me ';
    const input = document.createElement('input');
    input.type = 'checkbox';
    label.appendChild(input);
    document.body.appendChild(label);
    stubVisible(input);

    const results = scanInteractablesInPage();
    expect(results[0]?.name).toBe('Remember me');
  });

  it('returns null name when nothing resolves', () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    stubVisible(input);

    expect(scanInteractablesInPage()[0]?.name).toBeNull();
  });

  it('marks an element with zero-size bounding rect as not visible', () => {
    const btn = document.createElement('button');
    btn.textContent = 'Hidden';
    document.body.appendChild(btn);
    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    expect(scanInteractablesInPage()[0]?.visible).toBe(false);
  });

  it('marks an element hidden via visibility:hidden as not visible', () => {
    const btn = document.createElement('button');
    btn.textContent = 'Invisible';
    document.body.appendChild(btn);
    stubVisible(btn);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      visibility: 'hidden',
      display: 'block',
    } as CSSStyleDeclaration);

    expect(scanInteractablesInPage()[0]?.visible).toBe(false);
  });

  it('marks a native disabled input as disabled', () => {
    const input = document.createElement('input');
    input.disabled = true;
    document.body.appendChild(input);
    stubVisible(input);

    expect(scanInteractablesInPage()[0]?.disabled).toBe(true);
  });

  it('marks aria-disabled="true" as disabled even without the native attribute', () => {
    const btn = document.createElement('button');
    btn.setAttribute('aria-disabled', 'true');
    btn.textContent = 'Save';
    document.body.appendChild(btn);
    stubVisible(btn);

    expect(scanInteractablesInPage()[0]?.disabled).toBe(true);
  });

  it('truncates an over-long accessible name to 200 chars', () => {
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', 'x'.repeat(300));
    document.body.appendChild(btn);
    stubVisible(btn);

    expect(scanInteractablesInPage()[0]?.name).toHaveLength(200);
  });

  it('ignores an element with a matched-but-unmapped role (e.g. tab, no coarse kind)', () => {
    const div = document.createElement('div');
    div.setAttribute('role', 'tab');
    div.textContent = 'Tab 1';
    document.body.appendChild(div);
    stubVisible(div);

    // Selected by the querySelectorAll (role="tab" is in the candidate list)
    // but has no entry in KIND_BY_ROLE, so it must be filtered out entirely.
    expect(scanInteractablesInPage()).toEqual([]);
  });

  it('ignores a div with an unselected role entirely (not in the candidate query)', () => {
    const div = document.createElement('div');
    div.setAttribute('role', 'presentation');
    document.body.appendChild(div);
    stubVisible(div);

    expect(scanInteractablesInPage()).toEqual([]);
  });

  it('returns an empty array on a page with no candidates', () => {
    expect(scanInteractablesInPage()).toEqual([]);
  });

  it('never includes a password field value anywhere in the descriptor (login-page case)', () => {
    const input = document.createElement('input');
    input.type = 'password';
    input.value = 'hunter2';
    input.setAttribute('aria-label', 'Password');
    document.body.appendChild(input);
    stubVisible(input);

    const results = scanInteractablesInPage();
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain('hunter2');
    expect(results[0]).toEqual(
      expect.objectContaining({ role: 'textbox', kind: 'input', name: 'Password' }),
    );
  });
});
