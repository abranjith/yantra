import type { AgentBrowserObservation } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import { resolveFormField } from '../../../../src/adapters/pi/tools/form-field-resolve.js';
import type { DomainFailure } from '../../../../src/runtime/middleware.js';

/** Builds an observation from `[ref, role, name]` triples. */
function observation(
  ...entries: readonly (readonly [string, string, string])[]
): AgentBrowserObservation {
  return {
    url: 'https://example.com/search',
    title: 'Search',
    digest: 'a page',
    digestUnchanged: false,
    interactables: entries.map(([ref, role, name]) => ({ ref, role, name })),
  };
}

function isFailure(value: unknown): value is DomainFailure {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}

const KAYAK = observation(
  ['e14', 'combobox', 'Where to?'],
  ['e20', 'button', 'Check-in'],
  ['e21', 'button', 'Check-out'],
  ['e38', 'link', 'View more deals for Chicago Hotels'],
  ['e40', 'button', 'Search'],
);

describe('@no-llm resolveFormField', () => {
  it('resolves a literal eNN ref directly', () => {
    expect(resolveFormField('e14', KAYAK)).toMatchObject({ ref: 'e14', name: 'Where to?' });
  });

  it('returns STALE_ELEMENT_REF for an eNN absent from the observation', () => {
    const result = resolveFormField('e99', KAYAK);
    expect(isFailure(result) && result.errorCode).toBe('STALE_ELEMENT_REF');
  });

  it('matches an exact name case-insensitively', () => {
    expect(resolveFormField('check-in', KAYAK)).toMatchObject({ ref: 'e20' });
    expect(resolveFormField('CHECK-IN', KAYAK)).toMatchObject({ ref: 'e20' });
  });

  it('trims surrounding whitespace in the query', () => {
    expect(resolveFormField('  Check-in  ', KAYAK)).toMatchObject({ ref: 'e20' });
  });

  it('prefers an exact match over a prefix match', () => {
    const page = observation(['e1', 'textbox', 'Name'], ['e2', 'textbox', 'Name of company']);
    expect(resolveFormField('Name', page)).toMatchObject({ ref: 'e1' });
  });

  it('prefers a prefix match over a substring match', () => {
    const page = observation(
      ['e1', 'textbox', 'Departure city'],
      ['e2', 'textbox', 'City of departure'],
    );
    expect(resolveFormField('Departure', page)).toMatchObject({ ref: 'e1' });
  });

  it('falls through to a substring match when nothing else hits', () => {
    expect(resolveFormField('more deals', KAYAK)).toMatchObject({ ref: 'e38' });
  });

  it('errors rather than picking one when the winning tier is ambiguous', () => {
    // "Check-in" and "Check-out" share the "check-" prefix. Silently choosing
    // one would fill the wrong date and still look like success.
    const result = resolveFormField('Check-', KAYAK);
    expect(isFailure(result) && result.errorCode).toBe('FORM_FIELD_AMBIGUOUS');
    if (!isFailure(result)) throw new Error('expected a failure');
    expect(result.message).toContain('Check-in');
    expect(result.message).toContain('Check-out');
    expect(result.message).toContain('eNN');
    expect(result.retryable).toBe(true);
  });

  it('does not fall through to a narrower tier to escape ambiguity', () => {
    // Both entries match the "date" substring tier; the resolver must not keep
    // narrowing until exactly one survives.
    const page = observation(['e1', 'button', 'Start date'], ['e2', 'button', 'End date']);
    const result = resolveFormField('date', page);
    expect(isFailure(result) && result.errorCode).toBe('FORM_FIELD_AMBIGUOUS');
  });

  it('lists candidate names when nothing matches', () => {
    const result = resolveFormField('Passport number', KAYAK);
    expect(isFailure(result) && result.errorCode).toBe('FORM_FIELD_NOT_FOUND');
    if (!isFailure(result)) throw new Error('expected a failure');
    expect(result.message).toContain('Where to?');
    expect(result.message).toContain('Search');
    expect(result.retryable).toBe(true);
  });

  it('lists at most eight candidates and counts the rest', () => {
    const page = observation(
      ...Array.from({ length: 12 }, (_, i) => [`e${i}`, 'button', `Field ${i}`] as const),
    );
    const result = resolveFormField('nothing here', page);
    if (!isFailure(result)) throw new Error('expected a failure');
    expect(result.message).toContain('(+4 more)');
  });

  it('ignores unnamed elements when matching and when listing candidates', () => {
    const page = observation(['e1', 'button', ''], ['e2', 'button', '   '], ['e3', 'button', 'Go']);
    expect(resolveFormField('Go', page)).toMatchObject({ ref: 'e3' });
    const result = resolveFormField('absent', page);
    if (!isFailure(result)) throw new Error('expected a failure');
    expect(result.message).toContain('"Go"');
  });

  it('reports (none) when the page has no named fields at all', () => {
    const result = resolveFormField('anything', observation(['e1', 'button', '']));
    if (!isFailure(result)) throw new Error('expected a failure');
    expect(result.message).toContain('(none)');
  });

  it('rejects an empty field string', () => {
    const result = resolveFormField('   ', KAYAK);
    expect(isFailure(result) && result.errorCode).toBe('FORM_FIELD_NOT_FOUND');
  });

  it('refuses same-labeled fields during initial resolution and identifies each candidate', () => {
    // Run 20260827T045106Z-do-9a58de7e, seq 22: `"Where to?"` matched two
    // interactables — the page's combobox and the copy the open picker mounted
    // — and FORM_FIELD_AMBIGUOUS sent the agent off to operate the widget by
    // hand. They are one control, so document order settles it.
    const withDuplicate = observation(
      ['e66', 'combobox', 'Where to?'],
      ['e131', 'combobox', 'Where to?'],
    );
    const result = resolveFormField('Where to?', withDuplicate);
    if (!isFailure(result)) throw new Error('expected a failure');
    expect(result).toMatchObject({
      errorCode: 'FORM_FIELD_AMBIGUOUS',
      details: {
        candidates: [
          { ref: 'e66', name: 'Where to?', role: 'combobox', group: null },
          { ref: 'e131', name: 'Where to?', role: 'combobox', group: null },
        ],
      },
    });
    expect(result.message).toContain('e66');
    expect(result.message).toContain('e131');
  });

  it('still refuses when the same-named controls differ in role', () => {
    const mixed = observation(['e1', 'button', 'Date'], ['e2', 'textbox', 'Date']);
    const result = resolveFormField('Date', mixed);
    expect(isFailure(result) && result.errorCode).toBe('FORM_FIELD_AMBIGUOUS');
  });

  it('offers the tied names back in details so the caller can re-issue', () => {
    const result = resolveFormField('Check-', KAYAK);
    if (!isFailure(result)) throw new Error('expected a failure');
    expect(result.details).toMatchObject({ offered: ['Check-in', 'Check-out'] });
  });

  it('matches an autocomplete option by name (the e38 confusion)', () => {
    // The logged run clicked "View more deals for Chicago Hotels" — a marketing
    // tile — believing it was the suggestion. A real option must win on name.
    const withOption = observation(
      ['e38', 'link', 'View more deals for Chicago Hotels'],
      ['e51', 'option', 'Chicago, IL, United States'],
    );
    expect(resolveFormField('Chicago, IL, United States', withOption)).toMatchObject({
      ref: 'e51',
      role: 'option',
    });
  });
});
