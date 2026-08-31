/**
 * The WHAT rung, tested as pure functions.
 *
 * No port and no fixture: `query-plan.ts` holds only string and ranking logic,
 * and that is the property being protected here as much as the behaviour. The
 * fixture-driven end-to-end case lives with the combobox driver, where a port
 * exists.
 */

import { describe, expect, it } from 'vitest';

import {
  distinguishingPrefix,
  rankAgainstRequested,
  shapeQuery,
  PREFIX_RETREAT_MAX_CHARS,
} from '../../src/index.js';

const FULL_LABEL = 'San Jose Mineta International Airport (SJC)';

const option = (name: string, disabled = false) => ({ name, disabled });

describe('@no-llm shapeQuery', () => {
  it('retreats a long label to a genuine prefix a prefix matcher will answer', () => {
    // The run's seq 24: the agent obeyed a hint to re-type this whole label
    // into a prefix-matching autocomplete, and it matched nothing.
    const plan = shapeQuery(FULL_LABEL);
    const retreat = plan.find((form) => form.kind === 'prefix-retreat');

    expect(retreat).toBeDefined();
    expect(FULL_LABEL.startsWith(retreat!.text)).toBe(true);
    expect(retreat!.text.length).toBeLessThanOrEqual(PREFIX_RETREAT_MAX_CHARS);
    expect(retreat!.text).toBe('San Jose');
  });

  it('emits the code token before the prefix retreat', () => {
    // A widget that will not answer prose very often answers the machine
    // identifier the request already carries, so it is tried first.
    const kinds = shapeQuery(FULL_LABEL).map((form) => form.kind);

    expect(kinds).toEqual(['as-given', 'code-token', 'prefix-retreat']);
    expect(shapeQuery(FULL_LABEL).find((form) => form.kind === 'code-token')?.text).toBe('SJC');
  });

  it('emits only as-given for a plain short value', () => {
    expect(shapeQuery('Economy')).toEqual([{ kind: 'as-given', text: 'Economy' }]);
  });

  it('does not repeat a code token that is already the whole request', () => {
    // Typing the identical query twice and settling twice buys nothing but the
    // budget it spends.
    expect(shapeQuery('SJC')).toEqual([{ kind: 'as-given', text: 'SJC' }]);
  });

  it('refuses to choose between two code tokens', () => {
    const kinds = shapeQuery('DFW to SJC nonstop today').map((form) => form.kind);

    expect(kinds).not.toContain('code-token');
  });

  it('cuts the retreat at a word boundary rather than mid-word', () => {
    const retreat = shapeQuery('Reykjavik Keflavik Airport')!.find(
      (form) => form.kind === 'prefix-retreat',
    );

    expect(retreat?.text).toBe('Reykjavik');
  });

  it('returns nothing for an empty request', () => {
    expect(shapeQuery('   ')).toEqual([]);
  });
});

describe('@no-llm rankAgainstRequested', () => {
  it('selects the full-label candidate even though only a prefix was typed', () => {
    // The ranking half of the run's seq-24 trap: the query is shortened so the
    // widget will answer, and the answer is judged against the full request.
    const candidates = [option(FULL_LABEL), option('San Jose del Cabo Airport (SJD)')];

    expect(rankAgainstRequested(candidates, FULL_LABEL)).toEqual({
      kind: 'match',
      candidate: candidates[0],
    });
  });

  it('reports a genuine tie rather than settling it by position', () => {
    const candidates = [
      option('San Jose, CA, United States'),
      option('San Jose, Costa Rica'),
      option('Los Angeles, CA'),
    ];

    expect(rankAgainstRequested(candidates, 'San Jose')).toEqual({
      kind: 'ambiguous',
      offered: ['San Jose, CA, United States', 'San Jose, Costa Rica'],
    });
  });

  it('is stable: the same inputs rank the same way every time', () => {
    const candidates = [option('Dallas Fort Worth International Airport (DFW)'), option('Dallas')];
    const once = rankAgainstRequested(candidates, 'Dallas');
    const twice = rankAgainstRequested(candidates, 'Dallas');

    expect(once).toEqual(twice);
    expect(once).toMatchObject({ kind: 'match', candidate: { name: 'Dallas' } });
  });

  it('never ranks a disabled option', () => {
    const candidates = [option('San Jose, Costa Rica', true), option('San Jose, CA')];

    expect(rankAgainstRequested(candidates, 'San Jose')).toMatchObject({
      kind: 'match',
      candidate: { name: 'San Jose, CA' },
    });
  });

  it('reports what was offered when nothing matches', () => {
    const candidates = [option('Dallas'), option('Denver')];

    expect(rankAgainstRequested(candidates, 'San Jose')).toEqual({
      kind: 'none',
      offered: ['Dallas', 'Denver'],
    });
  });
});

describe('@no-llm distinguishingPrefix', () => {
  it('shortens an offered label to something a prefix matcher will answer', () => {
    const prefix = distinguishingPrefix(FULL_LABEL);

    expect(FULL_LABEL.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(FULL_LABEL.length);
  });

  it('grows past a shared opening so the prefix still picks out one entry', () => {
    // "San Jose" alone would offer both, which is the tie the caller already
    // resolved by naming the label it wants.
    const prefix = distinguishingPrefix('San Jose, Costa Rica', [
      'San Jose, CA, United States',
      'San Jose, Costa Rica',
    ]);

    expect('San Jose, Costa Rica'.startsWith(prefix)).toBe(true);
    expect('San Jose, CA, United States'.toLowerCase().startsWith(prefix.toLowerCase())).toBe(
      false,
    );
  });

  it('returns a short label unchanged rather than truncating it to nothing', () => {
    expect(distinguishingPrefix('Dallas')).toBe('Dallas');
  });
});
