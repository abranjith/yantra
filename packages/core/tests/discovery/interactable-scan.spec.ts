// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scanInteractablesInPage } from '../../src/discovery/interactable-scan.js';

function makeVisibleRect(top = 10, left = 10): DOMRect {
  return {
    top,
    left,
    bottom: top + 40,
    right: left + 100,
    width: 100,
    height: 40,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function stubVisible(el: Element, top = 10, left = 10): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(makeVisibleRect(top, left));
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
    delete (globalThis as typeof globalThis & { __yantra?: unknown }).__yantra;
    vi.restoreAllMocks();
  });

  it('finds a button by tag and text content', () => {
    const btn = document.createElement('button');
    btn.textContent = 'Search';
    document.body.appendChild(btn);
    stubVisible(btn);

    const results = scanInteractablesInPage();
    expect(results).toEqual([
      {
        role: 'button',
        name: 'Search',
        kind: 'button',
        disabled: false,
        top: 10,
        left: 10,
        group: null,
        scope: 'page',
        value: null,
        valuePresent: false,
        checked: null,
        expanded: null,
        selected: null,
        visible: true,
        selectorIndex: 0,
      },
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

  it('names a non-button element with role=button from its text fallback', () => {
    const day = document.createElement('div');
    day.setAttribute('role', 'button');
    day.textContent = '6';
    document.body.appendChild(day);
    stubVisible(day);

    expect(scanInteractablesInPage()[0]?.name).toBe('6');
  });

  it('keeps aria-label ahead of role=link text content', () => {
    const link = document.createElement('a');
    link.href = '#';
    link.setAttribute('role', 'link');
    link.setAttribute('aria-label', 'Home');
    link.innerHTML = '<svg></svg>Fallback';
    document.body.appendChild(link);
    stubVisible(link);

    expect(scanInteractablesInPage()[0]?.name).toBe('Home');
  });

  it('prefers the injected accessible-name engine when available', () => {
    const button = document.createElement('button');
    button.textContent = 'Heuristic Name';
    document.body.appendChild(button);
    stubVisible(button);
    (globalThis as typeof globalThis & { __yantra?: unknown }).__yantra = {
      describeAccessible: () => ({ role: 'button', name: 'Engine Name' }),
    };

    expect(scanInteractablesInPage()[0]?.name).toBe('Engine Name');
  });

  it('falls back when the injected accessible-name engine throws or returns empty', () => {
    const button = document.createElement('button');
    button.textContent = 'Heuristic Name';
    document.body.appendChild(button);
    stubVisible(button);
    const host = globalThis as typeof globalThis & { __yantra?: unknown };
    host.__yantra = {
      describeAccessible: () => {
        throw new Error('detached');
      },
    };
    expect(scanInteractablesInPage()[0]?.name).toBe('Heuristic Name');

    host.__yantra = { describeAccessible: () => ({ role: 'button', name: '' }) };
    expect(scanInteractablesInPage()[0]?.name).toBe('Heuristic Name');
  });

  it('keeps the scanner role map when the injected engine reports different roles', () => {
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Country');
    document.body.appendChild(select);
    stubVisible(select);
    const search = document.createElement('input');
    search.type = 'search';
    search.setAttribute('aria-label', 'Find');
    document.body.appendChild(search);
    stubVisible(search, 50);
    (globalThis as typeof globalThis & { __yantra?: unknown }).__yantra = {
      describeAccessible: (element: Element) => ({
        role: element === select ? 'listbox' : 'searchbox',
        name: element.getAttribute('aria-label') ?? '',
      }),
    };

    expect(scanInteractablesInPage().map(({ role }) => role)).toEqual(['combobox', 'textbox']);
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

  it('scans an autocomplete option and names it from its text content', () => {
    // Regression: `[role="option"]` was absent from the candidate selector, so
    // a destination combobox's real suggestions were structurally invisible to
    // every observation. The agent clicked a marketing tile instead.
    const option = document.createElement('li');
    option.setAttribute('role', 'option');
    option.textContent = 'Chicago, IL, United States';
    document.body.appendChild(option);
    stubVisible(option);

    expect(scanInteractablesInPage()).toEqual([
      expect.objectContaining({
        role: 'option',
        kind: 'select',
        name: 'Chicago, IL, United States',
      }),
    ]);
  });

  it('prefers an option aria-label over its text content', () => {
    const option = document.createElement('li');
    option.setAttribute('role', 'option');
    option.setAttribute('aria-label', 'Chicago O’Hare');
    option.textContent = 'ORD';
    document.body.appendChild(option);
    stubVisible(option);

    expect(scanInteractablesInPage()[0]?.name).toBe('Chicago O’Hare');
  });

  it('keeps ranking options by viewport top alongside other interactables', () => {
    const button = document.createElement('button');
    button.textContent = 'Search';
    document.body.appendChild(button);
    stubVisible(button, 200);

    const option = document.createElement('li');
    option.setAttribute('role', 'option');
    option.textContent = 'Chicago, IL';
    document.body.appendChild(option);
    stubVisible(option, 50);

    const results = scanInteractablesInPage();
    expect(results.map((r) => r.top)).toEqual([200, 50]);
    expect(results.map((r) => r.role)).toEqual(['button', 'option']);
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
      expect.objectContaining({
        role: 'textbox',
        kind: 'input',
        name: 'Password',
        value: null,
        valuePresent: true,
      }),
    );
  });

  it('computes labelled group context and visible dialog scope', () => {
    const grid = document.createElement('div');
    grid.setAttribute('role', 'grid');
    grid.innerHTML = '<h2>August 2026</h2><div role="button">6</div>';
    document.body.appendChild(grid);
    const day = grid.querySelector('[role="button"]')!;
    stubVisible(grid, 20);
    stubVisible(day, 50);

    expect(scanInteractablesInPage()[0]).toEqual(
      expect.objectContaining({ group: 'August 2026', scope: 'dialog' }),
    );

    grid.setAttribute('aria-label', 'Departure calendar');
    expect(scanInteractablesInPage()[0]?.group).toBe('Departure calendar');
  });

  it('does not promote children of a hidden dialog to dialog scope', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.style.display = 'none';
    dialog.innerHTML = '<button>Choose</button>';
    document.body.appendChild(dialog);
    const button = dialog.querySelector('button')!;
    stubVisible(dialog, 10);
    stubVisible(button, 20);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element) =>
        ({
          visibility: 'visible',
          display: element === dialog ? 'none' : 'block',
        }) as CSSStyleDeclaration,
    );

    expect(scanInteractablesInPage()[0]?.scope).toBe('page');
  });

  it('exposes ordinary values and state while withholding credential fields', () => {
    const input = document.createElement('input');
    input.value = 'Frisco, Texas';
    input.setAttribute('aria-label', 'Where to?');
    document.body.appendChild(input);
    stubVisible(input);
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.setAttribute('aria-label', 'Direct flights');
    document.body.appendChild(checkbox);
    stubVisible(checkbox, 50);
    const toggle = document.createElement('button');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = 'Dates';
    document.body.appendChild(toggle);
    stubVisible(toggle, 90);
    const otp = document.createElement('input');
    otp.autocomplete = 'one-time-code';
    otp.value = '123456';
    document.body.appendChild(otp);
    stubVisible(otp, 130);

    const results = scanInteractablesInPage();
    expect(results[0]?.value).toBe('Frisco, Texas');
    expect(results[1]?.checked).toBe(true);
    expect(results[2]?.expanded).toBe(false);
    expect(results[3]).toEqual(expect.objectContaining({ value: null, valuePresent: true }));
    expect(JSON.stringify(results)).not.toContain('123456');
  });

  it('normalizes and truncates exposed values to 120 characters', () => {
    const input = document.createElement('input');
    input.value = `  ${'x'.repeat(300)}  `;
    document.body.appendChild(input);
    stubVisible(input);

    expect(scanInteractablesInPage()[0]?.value).toHaveLength(120);
  });
});
