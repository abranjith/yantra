import { describe, expect, it } from 'vitest';

import { resolveInteractable, type AgentInteractable, type WidgetTarget } from '../../src/index.js';

/** Builds interactables from `[ref, role, name]` triples, in document order. */
function page(
  ...entries: readonly (readonly [string, string, string])[]
): readonly AgentInteractable[] {
  return entries.map(([ref, role, name]) => ({ ref, role, name }));
}

const preferred = (role: string, name: string, group: string | null = null): WidgetTarget => ({
  ref: 'e0',
  role,
  name,
  group,
  value: null,
});

describe('@no-llm resolveInteractable tiers', () => {
  it('resolves a literal ref without consulting names', () => {
    const result = resolveInteractable(
      'e2',
      page(['e1', 'button', 'Go'], ['e2', 'button', 'Stop']),
    );
    expect(result).toMatchObject({ kind: 'match', tier: 'ref', entry: { ref: 'e2' } });
  });

  it('reports none for a ref the page no longer has', () => {
    const result = resolveInteractable('e9', page(['e1', 'button', 'Go']));
    expect(result.kind).toBe('none');
  });

  it('prefers exact over prefix', () => {
    const result = resolveInteractable(
      'Name',
      page(['e1', 'textbox', 'Name'], ['e2', 'textbox', 'Name of company']),
    );
    expect(result).toMatchObject({ kind: 'match', tier: 'exact', entry: { ref: 'e1' } });
  });

  it('prefers prefix over token and substring', () => {
    const result = resolveInteractable(
      'Departure',
      page(['e1', 'textbox', 'Departure city'], ['e2', 'textbox', 'City of departure']),
    );
    expect(result).toMatchObject({ kind: 'match', tier: 'prefix', entry: { ref: 'e1' } });
  });

  it('matches on tokens in any order before falling back to substring', () => {
    const result = resolveInteractable(
      'deals more',
      page(['e1', 'link', 'View more deals for city hotels'], ['e2', 'button', 'Search']),
    );
    expect(result).toMatchObject({ kind: 'match', tier: 'all-tokens', entry: { ref: 'e1' } });
  });

  it('normalizes punctuation and case on both sides', () => {
    const result = resolveInteractable('  CHECK-IN  ', page(['e1', 'button', 'Check in']));
    expect(result).toMatchObject({ kind: 'match', tier: 'exact' });
  });

  it('ignores unnamed elements when matching and when listing', () => {
    const result = resolveInteractable(
      'absent',
      page(['e1', 'button', ''], ['e2', 'button', '  '], ['e3', 'button', 'Go']),
    );
    expect(result.kind).toBe('none');
    expect(result.kind === 'none' && result.offered.map((entry) => entry.ref)).toEqual(['e3']);
  });

  it('reports none for an empty query', () => {
    expect(resolveInteractable('   ', page(['e1', 'button', 'Go'])).kind).toBe('none');
  });
});

describe('@no-llm resolveInteractable tie-break ladder', () => {
  it('refuses same-named controls during initial resolution', () => {
    // The motivating failure: `"Where to?"` matched two interactables — the
    // page's own combobox and the copy the open picker mounted — and the
    // resolver refused instead of recognising them as one control.
    const result = resolveInteractable(
      'Where to?',
      page(['e66', 'combobox', 'Where to?'], ['e131', 'combobox', 'Where to?']),
    );
    expect(result.kind).toBe('ambiguous');
  });

  it('resolves a proven remount by document order during re-acquisition', () => {
    const result = resolveInteractable(
      'Where to?',
      page(['e66', 'combobox', 'Where to?'], ['e131', 'combobox', 'Where to?']),
      {
        preferred: preferred('combobox', 'Where to?'),
        allowEquivalentCopies: true,
      },
    );
    expect(result).toMatchObject({
      kind: 'match',
      entry: { ref: 'e66' },
      tieBreak: ['same-name-and-role'],
    });
  });

  it('does not let stale preferred identity authorize unrelated duplicates', () => {
    const result = resolveInteractable(
      'Date',
      page(['e66', 'button', 'Date'], ['e131', 'button', 'Date']),
      {
        preferred: preferred('button', 'Continue'),
        allowEquivalentCopies: true,
      },
    );
    expect(result.kind).toBe('ambiguous');
  });

  it('prefers the copy inside the container currently being operated', () => {
    const result = resolveInteractable(
      'Where to?',
      page(['e66', 'combobox', 'Where to?'], ['e131', 'combobox', 'Where to?']),
      { containedRefs: new Set(['e131']) },
    );
    expect(result).toMatchObject({ kind: 'match', entry: { ref: 'e131' } });
    expect(result.kind === 'match' && result.tieBreak).toContain('within-container');
  });

  it('still refuses to choose between two differently named fields', () => {
    // The safety boundary. "Check-in" and "Check-out" tie on the prefix tier,
    // differ in name, and must never be settled by document order — picking one
    // fills the wrong date and looks like success.
    const result = resolveInteractable(
      'Check-',
      page(['e20', 'button', 'Check-in'], ['e21', 'button', 'Check-out']),
    );
    expect(result).toMatchObject({ kind: 'ambiguous', tier: 'prefix' });
    expect(result.kind === 'ambiguous' && result.offered.map((entry) => entry.ref)).toEqual([
      'e20',
      'e21',
    ]);
  });

  it('refuses same-named controls that differ in role', () => {
    const result = resolveInteractable(
      'Date',
      page(['e1', 'button', 'Date'], ['e2', 'textbox', 'Date']),
    );
    expect(result.kind).toBe('ambiguous');
  });

  it('drops a disabled duplicate before ambiguity is considered', () => {
    const entries: AgentInteractable[] = [
      { ref: 'e1', role: 'button', name: 'Search', disabled: true },
      { ref: 'e2', role: 'button', name: 'Search' },
    ];
    const result = resolveInteractable('Search', entries);
    expect(result).toMatchObject({ kind: 'match', entry: { ref: 'e2' }, tieBreak: ['enabled'] });
  });

  it('does not let a disabled-only tier resolve to nothing', () => {
    const entries: AgentInteractable[] = [
      { ref: 'e1', role: 'button', name: 'Search', disabled: true },
      { ref: 'e2', role: 'button', name: 'Search', disabled: true },
    ];
    // Every survivor is disabled, so the `enabled` rung must not empty the pool.
    const result = resolveInteractable('Search', entries);
    expect(result.kind).toBe('ambiguous');
  });

  it('narrows by the preferred role when re-acquiring a known control', () => {
    const result = resolveInteractable(
      'Date',
      page(['e1', 'button', 'Date'], ['e2', 'textbox', 'Date']),
      { preferred: preferred('textbox', 'Date') },
    );
    expect(result).toMatchObject({ kind: 'match', entry: { ref: 'e2' } });
    expect(result.kind === 'match' && result.tieBreak).toContain('preferred-role');
  });

  it('narrows by the preferred group when role does not separate them', () => {
    const entries: AgentInteractable[] = [
      { ref: 'e1', role: 'combobox', name: 'Where to?', group: 'Flight' },
      { ref: 'e2', role: 'combobox', name: 'Where to?', group: 'Hotel' },
    ];
    const result = resolveInteractable('Where to?', entries, {
      preferred: preferred('combobox', 'Where to?', 'Hotel'),
    });
    expect(result).toMatchObject({ kind: 'match', entry: { ref: 'e2' } });
    expect(result.kind === 'match' && result.tieBreak).toContain('preferred-group');
  });

  it('refuses same-labeled controls in distinct groups even during re-acquisition', () => {
    const entries: AgentInteractable[] = [
      { ref: 'e1', role: 'combobox', name: 'Where to?', group: 'Flight' },
      { ref: 'e2', role: 'combobox', name: 'Where to?', group: 'Hotel' },
    ];
    const result = resolveInteractable('Where to?', entries, {
      preferred: preferred('combobox', 'Where to?'),
      allowEquivalentCopies: true,
    });
    expect(result.kind).toBe('ambiguous');
  });

  it('records an empty tieBreak when the tier already had one hit', () => {
    const result = resolveInteractable('Go', page(['e1', 'button', 'Go']));
    expect(result).toMatchObject({ kind: 'match', tieBreak: [] });
  });

  it('never narrows into a later tier to escape a tie', () => {
    // Both match the token tier; the substring tier would separate them, and
    // reaching for it would be inventing a preference the query never expressed.
    const result = resolveInteractable(
      'date',
      page(['e1', 'button', 'Start date'], ['e2', 'button', 'End date range date']),
    );
    expect(result.kind).toBe('ambiguous');
  });
});
