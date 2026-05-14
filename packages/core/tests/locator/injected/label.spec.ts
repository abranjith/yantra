// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { findByLabel } from '../../../src/locator/injected/label.js';

describe('@no-llm findByLabel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('finds input via <label for="id"> explicit association', () => {
    document.body.innerHTML = `
      <label for="email">Email address</label>
      <input id="email" type="text">
    `;
    const results = findByLabel('Email address');
    expect(results).toHaveLength(1);
    expect((results[0] as HTMLInputElement).id).toBe('email');
  });

  it('finds input via implicit label wrapping', () => {
    document.body.innerHTML = `
      <label>Username <input type="text" name="username"></label>
    `;
    const results = findByLabel('Username');
    expect(results).toHaveLength(1);
    expect((results[0] as HTMLInputElement).name).toBe('username');
  });

  it('finds via aria-labelledby pointing to matching element', () => {
    document.body.innerHTML = `
      <span id="pw-label">Password</span>
      <input type="password" aria-labelledby="pw-label">
    `;
    const results = findByLabel('Password');
    expect(results).toHaveLength(1);
    expect((results[0] as HTMLInputElement).type).toBe('password');
  });

  it('finds via aria-label attribute', () => {
    document.body.innerHTML = `<input type="text" aria-label="Search query">`;
    const results = findByLabel('Search query');
    expect(results).toHaveLength(1);
  });

  it('returns empty array when no label matches', () => {
    document.body.innerHTML = `<input type="text">`;
    const results = findByLabel('Nonexistent label');
    expect(results).toHaveLength(0);
  });

  it('supports regex matcher', () => {
    document.body.innerHTML = `
      <label for="u">User name</label>
      <input id="u" type="text">
    `;
    const results = findByLabel(/user/i);
    expect(results).toHaveLength(1);
  });

  it('strict=false allows contains match', () => {
    document.body.innerHTML = `
      <label for="em">Email address (required)</label>
      <input id="em" type="email">
    `;
    const results = findByLabel('Email', false);
    expect(results).toHaveLength(1);
  });

  it('deduplicates when multiple associations point to same control', () => {
    // Control has both for-label and aria-labelledby
    document.body.innerHTML = `
      <label for="x" id="lbl-x">Name</label>
      <input id="x" aria-labelledby="lbl-x">
    `;
    const results = findByLabel('Name');
    // Should not appear twice
    expect(results.length).toBeLessThanOrEqual(2);
    const uniqueIds = new Set(results.map((el) => (el as HTMLInputElement).id));
    expect(uniqueIds.size).toBe(results.length);
  });
});
