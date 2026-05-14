// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { findByTestId } from '../../../src/locator/injected/testid.js';

describe('@no-llm findByTestId', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('finds element by data-testid', () => {
    document.body.innerHTML = '<button data-testid="login-btn">Log in</button>';
    const results = findByTestId('login-btn');
    expect(results).toHaveLength(1);
    expect((results[0] as HTMLButtonElement).textContent).toBe('Log in');
  });

  it('finds element by data-test-id alias', () => {
    document.body.innerHTML = '<input data-test-id="username-field">';
    const results = findByTestId('username-field');
    expect(results).toHaveLength(1);
  });

  it('finds element by data-qa alias', () => {
    document.body.innerHTML = '<div data-qa="submit-action"></div>';
    const results = findByTestId('submit-action');
    expect(results).toHaveLength(1);
  });

  it('finds element by data-test alias', () => {
    document.body.innerHTML = '<span data-test="badge-count">5</span>';
    const results = findByTestId('badge-count');
    expect(results).toHaveLength(1);
  });

  it('returns empty array when attribute is missing', () => {
    document.body.innerHTML = '<button>No testid</button>';
    const results = findByTestId('login-btn');
    expect(results).toHaveLength(0);
  });

  it('returns multiple elements when two share the same value', () => {
    document.body.innerHTML = `
      <div data-testid="item">First</div>
      <div data-testid="item">Second</div>
    `;
    const results = findByTestId('item');
    expect(results).toHaveLength(2);
  });

  it('accepts custom attribute list', () => {
    document.body.innerHTML = '<input data-cy="my-input">';
    const results = findByTestId('my-input', ['data-cy']);
    expect(results).toHaveLength(1);
  });

  it('custom attribute list does not fall back to defaults', () => {
    document.body.innerHTML = '<input data-testid="x">';
    const results = findByTestId('x', ['data-cy']);
    expect(results).toHaveLength(0);
  });

  it('deduplicates when element has multiple aliases', () => {
    document.body.innerHTML = '<input data-testid="x" data-test-id="x">';
    const results = findByTestId('x');
    expect(results).toHaveLength(1);
  });
});
