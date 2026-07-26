import { describe, expect, it } from 'vitest';

import { sanitize } from '../../src/sanitizer/index.js';
import { ModelSuppliedValues } from '../../src/sanitizer/model-values.js';
import { UserInputVault, containsUserInputPlaceholder } from '../../src/sanitizer/user-input.js';

describe('@no-llm model-supplied value preservation', () => {
  it('keeps a value the model itself supplied out of the redactors', () => {
    // The regression this exists for: the agent navigated to
    // `?tracknumbers=874426145172` and the result came back as
    // `?tracknumbers=[redacted-phone]`, so it could not tell whether its own
    // action had worked. Redacting a value already in the model's context
    // protects nothing.
    const model = new ModelSuppliedValues();
    model.record({ url: 'https://www.fedex.com/fedextrack/?tracknumbers=874426145172' });

    const result = sanitize(
      { url: 'https://www.fedex.com/wtrk/track/?tracknumbers=874426145172', title: 'Tracking' },
      'public',
      undefined,
      { preserve: model.list() },
    );

    expect(result.text).toContain('874426145172');
    expect(result.text).not.toContain('[redacted-phone]');
  });

  it('still redacts third-party data the model never supplied', () => {
    const model = new ModelSuppliedValues();
    model.record({ url: 'https://example.com/orders/874426145172' });

    const result = sanitize(
      { text: 'Delivered. Signed by a@x.com, contact 415-555-0142 for 874426145172.' },
      'public',
      undefined,
      { preserve: model.list() },
    );

    expect(result.text).toContain('874426145172');
    expect(result.text).not.toContain('a@x.com');
    expect(result.text).not.toContain('415-555-0142');
  });

  it('records only model-authored strings, bounded in length', () => {
    const model = new ModelSuppliedValues();
    model.record({ ref: 'e12', value: '874426145172', nested: [{ kind: 'literal' }], count: 7 });

    // 'e12' is below the minimum length; numbers are not strings.
    expect(model.list()).toEqual(['874426145172', 'literal']);
  });
});

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

  it('leaves a bare tracking number visible (regression: 12 digits became a phone)', () => {
    // A 12-digit FedEx tracking number sits squarely inside the 10-15 digit
    // phone window. Tokenizing it hid the one value the task was ABOUT: the
    // agent could no longer tell its own filled value from an unresolved
    // token and reported a substitution failure that never happened.
    const vault = new UserInputVault();
    const goal =
      'track my fedex package for tracking number 874426145172 at ' +
      'https://www.fedex.com/en-us/tracking.html and show me the latest status';

    expect(vault.redact(goal)).toBe(goal);
    expect(vault.size).toBe(0);
  });

  it('never tokenizes the middle of a larger alphanumeric id', () => {
    // The phone candidate pattern carries no word boundaries, so the digit run
    // inside a UPS id used to be replaced in place: `1Z999AA{{user:phone:1}}`.
    const vault = new UserInputVault();
    const goal = 'where is 1Z999AA10123456784 and order ORD-2024-889912';

    expect(vault.redact(goal)).toBe(goal);
  });

  it('still tokenizes phone-shaped and context-labelled numbers', () => {
    const shaped = new UserInputVault();
    expect(shaped.redact('call +1 (555) 123-4567 now')).toBe('call {{user:phone:1}} now');
    expect(shaped.resolve(shaped.redact('call +1 (555) 123-4567 now'))).toBe(
      'call +1 (555) 123-4567 now',
    );

    // A bare digit run is ambiguous on shape alone, so nearby wording decides.
    const labelled = new UserInputVault();
    expect(labelled.redact('my phone is 5551234567')).toBe('my phone is {{user:phone:1}}');
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
