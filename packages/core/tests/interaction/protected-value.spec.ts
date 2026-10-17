// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  protectedScanOptions,
  scanInteractablesInPage,
} from '../../src/discovery/interactable-scan.js';
import {
  classifyCommitMatch,
  classifyWithheld,
  committedText,
  observedDetails,
  SENSITIVE_AUTOCOMPLETE_TOKENS,
  verifiedMatch,
  withheldDetails,
  type CommitMatch,
} from '../../src/interaction/protected-value.js';
import { readCommittedValue } from '../../src/widgets/verify.js';
import {
  protectedFacts as facts,
  protectedInputMarkup,
  WITHHELD_FACTS_TABLE,
} from '../support/protected-facts.js';
import { WidgetTestPort } from '../support/widget-test-port.js';

const field = { ref: 'e1', role: 'textbox', name: 'Field', group: null, value: null };

/** `[actual, expected, verdict]` — the comparator table both copies must agree on. */
const COMMIT_MATCH_TABLE: readonly (readonly [string, string, CommitMatch])[] = [
  ['', 'Passw0rd!', 'empty'],
  ['Passw0rd!', 'Passw0rd!', 'exact'],
  // Folded equality would call this exact; it is not what was sent.
  ['passw0rd', 'Passw0rd!', 'reformatted'],
  ['4111 1111 1111 1111', '4111111111111111', 'reformatted'],
  ['Passw0', 'Passw0rd!', 'truncated'],
  ['hunter2', 'Passw0rd!', 'different'],
  ['123', '123456', 'truncated'],
  ['12/28', '12/28', 'exact'],
  ['1228', '12/28', 'reformatted'],
  ['Synth3tic!pw', 'Synth3tic!pwX', 'truncated'],
  ['oldvalueSynth3tic!pw', 'Synth3tic!pw', 'different'],
  ['x', '', 'different'],
  ['  spaced  ', 'spaced', 'reformatted'],
  ['Ünïcode', 'ünïcode', 'reformatted'],
];

describe('@no-llm withheld commit verdicts', () => {
  it('classifies every row of the comparator table', () => {
    for (const [actual, expected, verdict] of COMMIT_MATCH_TABLE) {
      expect({ actual, expected, verdict: classifyCommitMatch(actual, expected) }).toEqual({
        actual,
        expected,
        verdict,
      });
    }
  });

  it('agrees with the in-page comparator on every row, never returning the value', async () => {
    for (const [actual, expected] of COMMIT_MATCH_TABLE) {
      const port = new WidgetTestPort('<input type="password" aria-label="Field">');
      port.document.querySelector('input')!.value = actual;
      const read = await readCommittedValue(port, field, { expected });
      expect({ actual, expected, read }).toEqual({
        actual,
        expected,
        read: {
          kind: 'withheld',
          reason: 'password',
          present: actual.length > 0,
          match: classifyCommitMatch(actual, expected),
        },
      });
    }
  });

  it('never maps a withheld value to text, and projects failures without the value', () => {
    const withheld = {
      kind: 'withheld',
      reason: 'autocomplete',
      present: true,
      match: 'truncated',
    } as const;
    expect(committedText(withheld)).toBeNull();
    expect(committedText({ kind: 'disclosed', text: '' })).toBe('');
    expect(verifiedMatch(withheld)).toBeNull();
    expect(verifiedMatch({ ...withheld, match: 'reformatted' })).toBe('reformatted');
    expect(verifiedMatch({ ...withheld, match: null })).toBeNull();
    expect(withheldDetails(withheld)).toEqual({
      withheld: 'autocomplete',
      match: 'truncated',
      present: true,
    });
    expect(observedDetails(withheld)).not.toHaveProperty('observed');
    expect(observedDetails({ kind: 'disclosed', text: 'Lyon' })).toEqual({ observed: 'Lyon' });
  });
});

describe('@no-llm protected-control classification', () => {
  it('reports each reason on its own', () => {
    expect(classifyWithheld(facts({ passwordInput: true }))).toBe('password');
    expect(classifyWithheld(facts({ autocomplete: 'cc-csc' }))).toBe('autocomplete');
    expect(classifyWithheld(facts({ secretMarker: true }))).toBe('secret_marker');
  });

  it('applies password > autocomplete > secret_marker precedence', () => {
    expect(
      classifyWithheld(
        facts({ passwordInput: true, autocomplete: 'cc-number', secretMarker: true }),
      ),
    ).toBe('password');
    expect(classifyWithheld(facts({ autocomplete: 'cc-exp', secretMarker: true }))).toBe(
      'autocomplete',
    );
  });

  it('matches whole tokens only, anywhere in the attribute, ignoring case', () => {
    expect(classifyWithheld(facts({ autocomplete: 'section-pay cc-number' }))).toBe('autocomplete');
    expect(classifyWithheld(facts({ autocomplete: '  shipping   Current-Password ' }))).toBe(
      'autocomplete',
    );
    expect(classifyWithheld(facts({ autocomplete: 'cc-name' }))).toBeNull();
    expect(classifyWithheld(facts({ autocomplete: 'cc-numbers' }))).toBeNull();
  });

  it('leaves ordinary fields disclosed', () => {
    for (const autocomplete of ['', 'email', 'tel', 'name', 'username', 'on', 'off']) {
      expect(classifyWithheld(facts({ autocomplete }))).toBeNull();
    }
  });

  it('protects exactly the documented token set', () => {
    expect([...SENSITIVE_AUTOCOMPLETE_TOKENS].sort()).toEqual(
      ['cc-csc', 'cc-exp', 'cc-number', 'current-password', 'new-password', 'one-time-code'].sort(),
    );
    for (const token of SENSITIVE_AUTOCOMPLETE_TOKENS) {
      expect(classifyWithheld(facts({ autocomplete: token }))).toBe('autocomplete');
    }
  });

  it('agrees with the in-page scan on every row of the facts table', () => {
    expect(WITHHELD_FACTS_TABLE).toHaveLength(12);
    for (const row of WITHHELD_FACTS_TABLE) {
      document.body.innerHTML = protectedInputMarkup(row, 'CANARY-classification');
      const [record] = scanInteractablesInPage(protectedScanOptions()).records;
      expect({ row: row.label, reason: record?.withheldReason }).toEqual({
        row: row.label,
        reason: classifyWithheld(row.facts),
      });
      expect(classifyWithheld(row.facts)).toBe(row.expected);
      // The scan withholds exactly the rows the classifier protects.
      expect({ row: row.label, withheld: record?.value === null }).toEqual({
        row: row.label,
        withheld: row.expected !== null,
      });
      if (row.expected !== null) {
        expect(record?.valuePresent).toBe(true);
        expect(JSON.stringify(record)).not.toContain('CANARY-classification');
      }
    }
  });

  it('reads the same reason through the committed read as through the scan', async () => {
    for (const row of WITHHELD_FACTS_TABLE) {
      const port = new WidgetTestPort(protectedInputMarkup(row, 'CANARY-read'));
      const read = await readCommittedValue(port, field);
      expect({ row: row.label, reason: read.kind === 'withheld' ? read.reason : null }).toEqual({
        row: row.label,
        reason: classifyWithheld(row.facts),
      });
      if (read.kind === 'withheld') expect(JSON.stringify(read)).not.toContain('CANARY-read');
    }
  });

  it('refuses to scan without the vocabulary rather than disclose a protected field', () => {
    document.body.innerHTML = '<input autocomplete="one-time-code" value="CANARY-otp">';
    expect(() => scanInteractablesInPage()).toThrow(TypeError);
    expect(() => scanInteractablesInPage({ max: 10 })).toThrow(
      /requires sensitiveAutocompleteTokens/u,
    );
  });
});
