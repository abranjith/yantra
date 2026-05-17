// @vitest-environment jsdom
/**
 * TASK-003: ElementDescriptor builder tests.
 *
 * Tests run in jsdom environment (no real browser needed).
 * Tagged @no-llm — must pass with LLM_PROVIDER=none.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { buildElementDescriptor } from '../../../../src/workflow/recorder/overlay/descriptor-builder.js';

describe('@no-llm buildElementDescriptor', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // ---------------------------------------------------------------------------
  // Basic element fingerprinting
  // ---------------------------------------------------------------------------

  it('produces correct tag, role, and accessible_name for a labeled button', () => {
    document.body.innerHTML = '<button data-testid="submit">Sign in</button>';
    const el = document.querySelector('button')!;
    const desc = buildElementDescriptor(el);

    expect(desc.tag).toBe('button');
    expect(desc.role).toBe('button');
    expect(desc.accessible_name).toBe('Sign in');
    expect(desc.attrs_sample['data-testid']).toBe('submit');
  });

  it('samples data-testid in attrs_sample', () => {
    document.body.innerHTML = '<button data-testid="login-btn">Login</button>';
    const el = document.querySelector('button')!;
    const desc = buildElementDescriptor(el);
    expect(desc.attrs_sample['data-testid']).toBe('login-btn');
  });

  it('computes accessible_name from aria-label', () => {
    document.body.innerHTML = '<button aria-label="Close dialog">X</button>';
    const el = document.querySelector('button')!;
    const desc = buildElementDescriptor(el);
    expect(desc.accessible_name).toBe('Close dialog');
  });

  it('computes accessible_name from associated <label for>', () => {
    document.body.innerHTML = `
      <label for="username">Username</label>
      <input id="username" type="text" />
    `;
    const el = document.querySelector('input')!;
    const desc = buildElementDescriptor(el);
    expect(desc.accessible_name).toBe('Username');
    expect(desc.role).toBe('textbox');
    expect(desc.tag).toBe('input');
  });

  it('computes accessible_name from wrapping <label>', () => {
    document.body.innerHTML = `
      <label>Email <input type="email" /></label>
    `;
    const el = document.querySelector('input')!;
    const desc = buildElementDescriptor(el);
    expect(desc.accessible_name).toBe('Email');
  });

  it('computes accessible_name from aria-labelledby', () => {
    document.body.innerHTML = `
      <span id="heading-text">Full Name</span>
      <input type="text" aria-labelledby="heading-text" />
    `;
    const el = document.querySelector('input')!;
    const desc = buildElementDescriptor(el);
    expect(desc.accessible_name).toBe('Full Name');
  });

  // ---------------------------------------------------------------------------
  // Password field protection
  // ---------------------------------------------------------------------------

  it('replaces non-allowlisted aria-label on password fields with <password-field>', () => {
    document.body.innerHTML =
      '<input type="password" aria-label="Enter your secret passphrase here please" />';
    const el = document.querySelector('input')!;
    const desc = buildElementDescriptor(el);
    // The aria-label is not in the allowlist → should be replaced
    expect(desc.attrs_sample['aria-label']).toBe('<password-field>');
  });

  it('preserves allowlisted aria-label on password fields', () => {
    document.body.innerHTML = '<input type="password" aria-label="Password" />';
    const el = document.querySelector('input')!;
    const desc = buildElementDescriptor(el);
    expect(desc.attrs_sample['aria-label']).toBe('Password');
  });

  // ---------------------------------------------------------------------------
  // Attribute sanitization
  // ---------------------------------------------------------------------------

  it('truncates attribute values to 100 chars', () => {
    const longVal = 'a'.repeat(200);
    document.body.innerHTML = `<input placeholder="${longVal}" />`;
    const el = document.querySelector('input')!;
    const desc = buildElementDescriptor(el);
    expect(desc.attrs_sample['placeholder']!.length).toBeLessThanOrEqual(100);
  });

  it('strips control characters from attribute values', () => {
    document.body.innerHTML = '<input id="test\x00val" />';
    const el = document.querySelector('input')!;
    const desc = buildElementDescriptor(el);
    // Control chars should be stripped from id
    if (desc.attrs_sample['id']) {
      // eslint-disable-next-line no-control-regex
      expect(desc.attrs_sample['id']).not.toMatch(/[\x00-\x1f]/);
    }
  });

  it('defangs credential-shaped attribute values', () => {
    document.body.innerHTML = '<input placeholder="sk-proj-ABCDEFGHIJKLMNOP" />';
    const el = document.querySelector('input')!;
    const desc = buildElementDescriptor(el);
    expect(desc.attrs_sample['placeholder']).toBe('<defanged>');
  });

  it('does not sample value or checked attributes', () => {
    document.body.innerHTML = '<input type="text" value="my-secret" />';
    const el = document.querySelector('input')!;
    const desc = buildElementDescriptor(el);
    expect('value' in desc.attrs_sample).toBe(false);
    expect('checked' in desc.attrs_sample).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Bounding rect and iframe detection
  // ---------------------------------------------------------------------------

  it('includes bounding_rect with numeric fields', () => {
    document.body.innerHTML = '<button>Click</button>';
    const el = document.querySelector('button')!;
    const desc = buildElementDescriptor(el);
    expect(typeof desc.bounding_rect.x).toBe('number');
    expect(typeof desc.bounding_rect.y).toBe('number');
    expect(typeof desc.bounding_rect.width).toBe('number');
    expect(typeof desc.bounding_rect.height).toBe('number');
  });

  it('sets in_iframe to false for elements in the main document', () => {
    document.body.innerHTML = '<button>Click</button>';
    const el = document.querySelector('button')!;
    const desc = buildElementDescriptor(el);
    expect(desc.in_iframe).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // XPath generation
  // ---------------------------------------------------------------------------

  it('generates an absolute xpath starting with /', () => {
    document.body.innerHTML = '<button>Click</button>';
    const el = document.querySelector('button')!;
    const desc = buildElementDescriptor(el);
    expect(desc.xpath_for_debug).toMatch(/^\//);
  });

  it('caps xpath at 200 chars', () => {
    // Create a deeply nested element
    let html = '';
    for (let i = 0; i < 30; i++) html = `<div class="deep">${html}</div>`;
    html = `<div>${html}<span>target</span></div>`;
    document.body.innerHTML = html;
    const spans = document.querySelectorAll('span');
    if (spans.length > 0) {
      const desc = buildElementDescriptor(spans[0]!);
      expect(desc.xpath_for_debug.length).toBeLessThanOrEqual(200);
    }
  });

  // ---------------------------------------------------------------------------
  // Text truncation
  // ---------------------------------------------------------------------------

  it('truncates visible_text at 200 chars', () => {
    const longText = 'word '.repeat(60);
    document.body.innerHTML = `<p>${longText}</p>`;
    const el = document.querySelector('p')!;
    const desc = buildElementDescriptor(el);
    if (desc.visible_text) {
      expect(desc.visible_text.length).toBeLessThanOrEqual(200);
    }
  });

  it('truncates accessible_name at 200 chars', () => {
    const longLabel = 'a'.repeat(300);
    document.body.innerHTML = `<button aria-label="${longLabel}">btn</button>`;
    const el = document.querySelector('button')!;
    const desc = buildElementDescriptor(el);
    if (desc.accessible_name) {
      expect(desc.accessible_name.length).toBeLessThanOrEqual(200);
    }
  });

  // ---------------------------------------------------------------------------
  // Role computation for input types
  // ---------------------------------------------------------------------------

  it('assigns role=checkbox to checkbox inputs', () => {
    document.body.innerHTML = '<input type="checkbox" />';
    const el = document.querySelector('input')!;
    const desc = buildElementDescriptor(el);
    expect(desc.role).toBe('checkbox');
  });

  it('assigns role=radio to radio inputs', () => {
    document.body.innerHTML = '<input type="radio" />';
    const el = document.querySelector('input')!;
    const desc = buildElementDescriptor(el);
    expect(desc.role).toBe('radio');
  });

  it('assigns role=button to submit inputs', () => {
    document.body.innerHTML = '<input type="submit" value="Submit" />';
    const el = document.querySelector('input')!;
    const desc = buildElementDescriptor(el);
    expect(desc.role).toBe('button');
  });

  it('assigns role=link to anchor elements', () => {
    document.body.innerHTML = '<a href="/dashboard">Dashboard</a>';
    const el = document.querySelector('a')!;
    const desc = buildElementDescriptor(el);
    expect(desc.role).toBe('link');
  });
});
