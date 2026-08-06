import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { redactRunInput, sanitize } from '../../src/sanitizer/index.js';
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
  it('redacts goal and profile together and returns safe advisory warnings', () => {
    const result = redactRunInput({
      goal: 'login with password p1',
      profileContext: 'backup jane@example.org',
    });

    expect(result.goal).toBe('login with password {{user:password:1}}');
    expect(result.profileContext).toBe('backup {{user:email:1}}');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('@{...}');
    expect(result.warnings.join(' ')).not.toContain('p1');
  });

  it('gives explicit markers structural precedence over every heuristic', () => {
    const vault = new UserInputVault();
    const redacted = vault.redact(
      'enter website xyz with @username{u1} and @password{p1}; email @password{a@b.com}',
    );

    expect(redacted).toBe(
      'enter website xyz with {{user:username:1}} and {{user:password:1}}; email {{user:password:2}}',
    );
    expect(redacted).toContain('xyz');
    expect(redacted).not.toContain('{{user:email:');
  });

  it('tokenizes marked values that fail every shape gate and protects inner shapes', () => {
    const vault = new UserInputVault();
    const redacted = vault.redact('use @{7}, @{ok}, and @{contact a@b.com now}');

    expect(redacted).toBe('use {{user:secret:1}}, {{user:secret:2}}, and {{user:secret:3}}');
    expect(redacted).not.toContain('{{user:email:');
    expect(vault.resolve(redacted)).toBe('use 7, ok, and contact a@b.com now');
  });

  it('deduplicates repeated marked values without reprocessing marker output', () => {
    const vault = new UserInputVault();

    expect(vault.redact('@password{p1} then @password{p1}')).toBe(
      '{{user:password:1}} then {{user:password:1}}',
    );
    expect(vault.redact('@{literal {{user: prefix text}}}')).toContain('{{user:secret:');
  });

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

  it('masks short values only at standalone positions', () => {
    const vault = new UserInputVault();
    const placeholder = vault.redact('@username{u1}');

    expect(vault.mask('logged in as u1; Ju1ce and u12 stay')).toBe(
      `logged in as ${placeholder}; Ju1ce and u12 stay`,
    );
  });

  it('protects placeholder spans and is idempotent', () => {
    const vault = new UserInputVault();
    const placeholder = vault.redact('@{user}');

    expect(placeholder).toBe('{{user:secret:1}}');
    expect(vault.mask(placeholder)).toBe(placeholder);
    expect(vault.mask(vault.mask(`hello user ${placeholder}`))).toBe(
      `hello ${placeholder} ${placeholder}`,
    );
  });

  it('keeps long substring masking and handles overlaps longest-first', () => {
    const cardVault = new UserInputVault();
    const cardPlaceholder = cardVault.redact('card 4111111111111111').split(' ')[1]!;
    expect(cardVault.mask('id=4111111111111111&x=1')).toBe(`id=${cardPlaceholder}&x=1`);

    const overlap = new UserInputVault();
    const short = overlap.redact('@{abc}');
    const long = overlap.redact('@{abcdef}');
    expect(overlap.mask('abcdef abc')).toBe(`${long} ${short}`);
  });

  it('neutralizes known placeholders for durable persistence', () => {
    const vault = new UserInputVault();
    const redacted = vault.redact('login with @password{p1}');

    expect(vault.neutralize(redacted)).toBe('login with [user-provided password]');
    expect(vault.neutralize('{{user:password:99}}')).toBe('{{user:password:99}}');
  });

  it('warns once when a marked value is too short for substring echo masking', () => {
    const vault = new UserInputVault();
    vault.redact('@{u1} and @password{long-enough}');

    expect(vault.warnOnShortValues()).toHaveLength(1);
  });

  it('applies keyword detection before shape detection', () => {
    const vault = new UserInputVault();

    expect(vault.redact('ssn 123-45-6789 and password 4111111111111111')).toBe(
      'ssn {{user:national_id:1}} and password {{user:password:1}}',
    );
  });

  it('redacts valid VINs but leaves invalid and embedded lookalikes visible', () => {
    const vault = new UserInputVault();

    expect(vault.redact('vehicle 1HGCM82633A004352')).toBe('vehicle {{user:vin:1}}');
    expect(vault.redact('vehicle 1HGCM82633A004353')).toBe('vehicle 1HGCM82633A004353');
    expect(vault.redact('id-1HGCM82633A004352-suffix')).toBe('id-1HGCM82633A004352-suffix');
  });

  it('property: marked values never enter redacted text and resolve to marker-stripped input', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z0-9]{4,24}$/), (suffix) => {
        const value = `MARKED-${suffix}`;
        const vault = new UserInputVault();
        const redacted = vault.redact(`before @password{${value}} after`);
        expect(redacted).not.toContain(value);
        expect(vault.resolve(redacted)).toBe(`before ${value} after`);
      }),
      { numRuns: 200 },
    );
  });

  it('property: masking removes every standalone stored value', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z0-9]{8,24}$/), (value) => {
        const vault = new UserInputVault();
        vault.redact(`@{${value}}`);
        expect(vault.mask(`prefix-${value}-suffix`)).not.toContain(value);
      }),
      { numRuns: 200 },
    );
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
