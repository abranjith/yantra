import { describe, expect, it } from 'vitest';

import { sanitize } from '../../src/sanitizer/index.js';
import { UserInputVault, containsUserInputPlaceholder } from '../../src/sanitizer/user-input.js';

describe('@no-llm user-input vault redaction', () => {
  it('replaces an email with an indexed placeholder and resolves it back exactly', () => {
    const vault = new UserInputVault();

    const redacted = vault.redact('email john.doe@example.com about the meeting');

    expect(redacted).toBe('email {{user:email:1}} about the meeting');
    expect(vault.resolve(redacted)).toBe('email john.doe@example.com about the meeting');
  });

  it('round-trips every supported value class (email, phone, ssn, card, api key)', () => {
    const vault = new UserInputVault();
    const original =
      'use john@example.com, call +1 (555) 123-4567, SSN 123-45-6789, ' +
      'card 4111111111111111, key sk-abcdefghijklmnopqrstuvwxyz123456';

    const redacted = vault.redact(original);

    expect(redacted).not.toContain('john@example.com');
    expect(redacted).not.toContain('123-45-6789');
    expect(redacted).not.toContain('4111111111111111');
    expect(redacted).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(vault.resolve(redacted)).toBe(original);
  });

  it('deduplicates identical values and indexes distinct ones', () => {
    const vault = new UserInputVault();

    const redacted = vault.redact('cc a@x.com and b@y.com, reply to a@x.com');

    expect(redacted).toBe('cc {{user:email:1}} and {{user:email:2}}, reply to {{user:email:1}}');
    expect(vault.size).toBe(2);
  });

  it('does not HTML-mangle plain goal text (regression: cheerio round trip)', () => {
    const vault = new UserInputVault();
    const goal = 'find laptops under $1500 & compare Dell vs HP, note: 5 < 8';

    expect(vault.redact(goal)).toBe(goal);
  });

  it('tokenizes auth query param values but keeps the URL navigable after resolve', () => {
    const vault = new UserInputVault();
    const url = 'open https://app.example.com/share?id=42&token=abc123SECRET&view=full';

    const redacted = vault.redact(url);

    expect(redacted).not.toContain('abc123SECRET');
    expect(redacted).toContain('?id=42&token={{user:auth_param:1}}&view=full');
    expect(vault.resolve(redacted)).toBe(url);
  });

  it('leaves Luhn-invalid long numbers visible (order/tracking ids stay usable)', () => {
    const vault = new UserInputVault();
    const goal = 'track order 1234567890123456';

    expect(vault.redact(goal)).toBe(goal);
  });

  it('leaves unknown (model-invented) placeholders untouched on resolve', () => {
    const vault = new UserInputVault();
    vault.redact('a@x.com');

    expect(vault.resolve('fill {{user:email:99}} here')).toBe('fill {{user:email:99}} here');
  });

  it('masks raw values echoed by a page back into their stable placeholders', () => {
    const vault = new UserInputVault();
    vault.redact('sign up with a@x.com');

    const echoed = vault.mask('Thanks! We sent a confirmation to a@x.com.');

    expect(echoed).toBe('Thanks! We sent a confirmation to {{user:email:1}}.');
  });

  it('resolve and mask are identity operations on an empty vault', () => {
    const vault = new UserInputVault();

    expect(vault.resolve('plain text')).toBe('plain text');
    expect(vault.mask('plain text')).toBe('plain text');
    expect(vault.size).toBe(0);
  });

  it('placeholders survive the standard payload sanitizer untouched', () => {
    const vault = new UserInputVault();
    const redacted = vault.redact('email a@x.com and call +1 (555) 123-4567');

    const sanitized = sanitize(redacted, 'public').text;

    expect(sanitized).toContain('{{user:email:1}}');
    expect(sanitized).toContain('{{user:phone:1}}');
    expect(sanitized).not.toContain('a@x.com');
  });

  it('containsUserInputPlaceholder detects the token shape', () => {
    expect(containsUserInputPlaceholder('x {{user:email:1}} y')).toBe(true);
    expect(containsUserInputPlaceholder('no tokens here')).toBe(false);
  });
});
