// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  findByPlaceholder,
  findByNameAttribute,
} from '../../../src/locator/injected/placeholder.js';

describe('@no-llm findByPlaceholder', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('finds input by exact placeholder', () => {
    document.body.innerHTML = '<input placeholder="Enter email">';
    const results = findByPlaceholder('Enter email');
    expect(results).toHaveLength(1);
  });

  it('finds textarea by placeholder', () => {
    document.body.innerHTML = '<textarea placeholder="Write your message"></textarea>';
    const results = findByPlaceholder('Write your message');
    expect(results).toHaveLength(1);
  });

  it('returns empty when placeholder does not match', () => {
    document.body.innerHTML = '<input placeholder="Search">';
    const results = findByPlaceholder('Enter email');
    expect(results).toHaveLength(0);
  });

  it('supports regex matcher', () => {
    document.body.innerHTML = '<input placeholder="Enter your email address">';
    const results = findByPlaceholder(/email/i);
    expect(results).toHaveLength(1);
  });

  it('returns multiple inputs when multiple match', () => {
    document.body.innerHTML = `
      <input placeholder="Enter email">
      <textarea placeholder="Enter email"></textarea>
    `;
    const results = findByPlaceholder('Enter email');
    expect(results).toHaveLength(2);
  });

  it('strict=false allows contains match', () => {
    document.body.innerHTML = '<input placeholder="Enter email address">';
    const results = findByPlaceholder('Enter email', false);
    expect(results).toHaveLength(1);
  });

  it('ignores elements without placeholder attribute', () => {
    document.body.innerHTML = '<input type="text"><input placeholder="x">';
    const results = findByPlaceholder('x');
    expect(results).toHaveLength(1);
  });
});

describe('@no-llm findByNameAttribute', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('finds input by name attribute', () => {
    document.body.innerHTML = '<input name="username">';
    const results = findByNameAttribute('username');
    expect(results).toHaveLength(1);
  });

  it('returns empty when name does not match', () => {
    document.body.innerHTML = '<input name="password">';
    const results = findByNameAttribute('username');
    expect(results).toHaveLength(0);
  });
});
