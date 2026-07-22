import { describe, expect, it } from 'vitest';

import { DEFAULT_HOST_OVERRIDES } from '../../src/sanitizer/host-overrides.js';
import { sanitize } from '../../src/sanitizer/index.js';
import {
  redactAccountNumber,
  redactDriversLicense,
  redactIban,
  redactMedicalRecordNumber,
  redactMemberId,
  redactPassportNumber,
  redactTaxId,
} from '../../src/sanitizer/strippers.js';

describe('@no-llm production host-override redactors', () => {
  it('redacts context-anchored account numbers, not bare numbers', () => {
    expect(redactAccountNumber('Account number: 123456789012').hits).toBe(1);
    expect(redactAccountNumber('acct #98765432').hits).toBe(1);
    // A bare number without an anchoring label stays visible.
    expect(redactAccountNumber('confirmation 123456789012').hits).toBe(0);
  });

  it('redacts IBANs by format alone', () => {
    const result = redactIban('wire to DE44500105175407324931 today');
    expect(result.text).toContain('[redacted-iban]');
    expect(result.hits).toBe(1);
  });

  it('redacts member/policy ids only with an anchoring label', () => {
    expect(redactMemberId('Member ID: ABC1234567').hits).toBe(1);
    expect(redactMemberId('policy number XZY-99887').hits).toBe(1);
    expect(redactMemberId('the member arrived at 10').hits).toBe(0);
  });

  it('redacts medical record numbers with an MRN label', () => {
    expect(redactMedicalRecordNumber('MRN: 445-88-221').hits).toBe(1);
    expect(redactMedicalRecordNumber('medical record number 8845123').hits).toBe(1);
  });

  it('redacts EIN-shaped tax ids', () => {
    const result = redactTaxId('EIN 12-3456789 on file');
    expect(result.text).toContain('[redacted-tax-id]');
  });

  it('redacts passport numbers only when they contain a digit (no prose FPs)', () => {
    expect(redactPassportNumber('passport number A12345678').hits).toBe(1);
    // Regression guard: "passport renewal" must NOT be swallowed.
    expect(redactPassportNumber('passport renewal appointment').hits).toBe(0);
  });

  it('redacts drivers license numbers with an anchoring label and digit', () => {
    expect(redactDriversLicense("driver's license no: D123-4567-8901").hits).toBe(1);
    expect(redactDriversLicense('a new license plate').hits).toBe(0);
  });

  it('applies the new tags through sanitize() for a matching production host', () => {
    // 8 digits: below the generic phone redactor's floor, so only the host
    // override's account-number redactor can catch it.
    const text = 'Balance $1,204.55 for Account number: 98765432';

    const result = sanitize(text, 'authenticated', 'https://secure.wellsfargo.com/home');

    expect(result.text).not.toContain('98765432');
    expect(result.text).not.toContain('$1,204.55');
    expect(result.transformationsApplied).toContain('host-override-account-number');
    expect(result.transformationsApplied).toContain('host-override-currency-usd');
  });

  it('ships every default override with the authenticated profile and at least one redactor', () => {
    expect(DEFAULT_HOST_OVERRIDES.length).toBeGreaterThanOrEqual(40);
    for (const override of DEFAULT_HOST_OVERRIDES) {
      expect(override.inherits).toBe('authenticated');
      expect(override.extraRedactors.length).toBeGreaterThan(0);
    }
  });

  it('keeps the packaged YAML in sync with the compiled defaults', async () => {
    const { FileHostOverrideStore } = await import('../../src/sanitizer/host-overrides.js');
    const store = new FileHostOverrideStore('Z:/definitely/missing/sanitizer-hosts.yaml');

    const fromYaml = await store.load();

    expect(fromYaml.map((entry) => entry.hostPattern)).toEqual(
      DEFAULT_HOST_OVERRIDES.map((entry) => entry.hostPattern),
    );
    expect(fromYaml.map((entry) => [...entry.extraRedactors])).toEqual(
      DEFAULT_HOST_OVERRIDES.map((entry) => [...entry.extraRedactors]),
    );
  });
});
