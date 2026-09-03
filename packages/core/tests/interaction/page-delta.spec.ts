/**
 * The delta, tested as the claims it must never manufacture.
 *
 * Almost every case here is one where a naive differ reports a change that did
 * not happen: refs traded between reordered same-named controls, a stationary
 * element pushed past the model cap, a control remounted identically, a
 * navigation that makes two frames incomparable. `diffFingerprints` is pure and
 * total, so each of those is decidable from two constructed frames with no page
 * and no port at all — which is what proves the design rather than exercising it.
 *
 * Nothing here names a site. Every fixture is structural: role, accessible
 * name, group, scope, focus, epoch, URL.
 */

import { describe, expect, it } from 'vitest';

import type { RawInteractable } from '../../src/discovery/interactable-scan.js';
import { diffKeyed } from '../../src/interaction/differ.js';
import {
  DELTA_DIALOG_CAP,
  DELTA_MAX_BYTES,
  DELTA_SAMPLE_CAP,
  FINGERPRINT_MAX_ENTRIES,
  IDENTITY_PART_MAX_CHARS,
  deltaBytes,
  diffFingerprints,
  fingerprintFromScan,
  identityKey,
  type ObservationFingerprint,
} from '../../src/interaction/page-delta.js';

/**
 * The identity-key separator, built rather than typed.
 *
 * `String.fromCodePoint` instead of a literal, so this fixture provably carries
 * no raw control byte: a literal U+001F in a source file makes `grep` and
 * `file` treat the whole file as binary, which has already hidden one document
 * in this repository from search.
 */
const SEPARATOR = String.fromCodePoint(0x1f);

interface EntrySpec {
  readonly role?: string;
  readonly name?: string;
  readonly group?: string | null;
  readonly scope?: 'dialog' | 'page';
  readonly focused?: boolean;
  readonly container?: { readonly role: string; readonly name: string } | null;
}

function entry(spec: EntrySpec = {}): RawInteractable {
  return {
    role: spec.role ?? 'button',
    name: spec.name ?? 'Go',
    kind: 'button',
    disabled: false,
    top: 0,
    left: 0,
    group: spec.group ?? null,
    scope: spec.scope ?? 'page',
    value: null,
    valuePresent: false,
    checked: null,
    expanded: null,
    selected: null,
    visible: true,
    elementIndex: 0,
    composedScope: 'document',
    rootNodeDepth: 0,
    focused: spec.focused ?? false,
    container: spec.container ?? null,
  };
}

function frame(
  entries: readonly RawInteractable[],
  overrides: Partial<ObservationFingerprint> = {},
): ObservationFingerprint {
  const url = overrides.url ?? 'https://example.test/';
  const title = overrides.title ?? 'Example';
  return {
    epoch: 'y1',
    ...fingerprintFromScan(url, title, entries, overrides.degraded ?? false),
    ...overrides,
  };
}

describe('@no-llm identityKey', () => {
  it('is the semantic identity, carrying no ref and no position', () => {
    const key = identityKey('option', 'Dallas', 'Suggestions', 'dialog');

    expect(key).toContain('option');
    expect(key).toContain('Dallas');
    expect(key).not.toContain('e1');
  });

  it('treats a missing name and a missing group as empty rather than absent', () => {
    expect(identityKey('button', null, null, 'page')).toBe(identityKey('button', '', '', 'page'));
  });

  it('clamps every part, so one enormous accessible name cannot unbound a key', () => {
    const key = identityKey('button', 'x'.repeat(500), 'y'.repeat(500), 'page');

    for (const part of key.split(SEPARATOR)) {
      expect(part.length).toBeLessThanOrEqual(IDENTITY_PART_MAX_CHARS);
    }
  });

  it('separates parts so two different splits cannot collide', () => {
    expect(identityKey('button', 'a', 'b', 'page')).not.toBe(
      identityKey('button', 'ab', '', 'page'),
    );
  });

  it('joins exactly four parts with the unit separator', () => {
    expect(identityKey('a', 'b', 'c', 'd').split(SEPARATOR)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('@no-llm diffFingerprints', () => {
  it('reports nothing at all for an unchanged page', () => {
    const entries = [entry({ name: 'Search' }), entry({ name: 'Filter' })];

    const delta = diffFingerprints(frame(entries), frame(entries));

    expect(delta).toEqual({});
    expect(delta.incomplete).toBeUndefined();
    expect(delta.complete).toBeUndefined();
  });

  it('reports zero change when same-named controls merely reorder', () => {
    // The single failure a ref-based delta would ship silently: refs are minted
    // by (role, name, ordinal), so these three trade identities on reorder.
    const before = [
      entry({ name: 'Search', group: 'Row 1' }),
      entry({ name: 'Search', group: 'Row 2' }),
      entry({ name: 'Search', group: 'Row 3' }),
    ];
    const after = [before[2]!, before[0]!, before[1]!];

    const delta = diffFingerprints(frame(before), frame(after));

    expect(delta.elements_appeared).toBeUndefined();
    expect(delta.elements_vanished).toBeUndefined();
  });

  it('reports zero change when a control is remounted identically', () => {
    const before = [entry({ role: 'textbox', name: 'Destination' })];
    const after = [entry({ role: 'textbox', name: 'Destination' })];

    const delta = diffFingerprints(frame(before), frame(after));

    expect(delta.elements_appeared).toBeUndefined();
    expect(delta.elements_vanished).toBeUndefined();
  });

  it('is visibly a different answer from the ref policy on the same remount', () => {
    // Asserted directly, because "one differ API, two identity policies" is
    // only a real claim if the two policies demonstrably disagree here.
    const refDiff = diffKeyed([{ ref: 'e4' }], [{ ref: 'e9' }], { key: (item) => item.ref });

    expect(refDiff.appearedCount).toBe(1);
    expect(refDiff.vanishedCount).toBe(1);
  });

  it('counts a genuine appearance and names a bounded sample of it', () => {
    const before = [entry({ name: 'Search' })];
    const after = [
      entry({ name: 'Search' }),
      entry({ role: 'option', name: 'Dallas' }),
      entry({ role: 'option', name: 'Denver' }),
    ];

    const delta = diffFingerprints(frame(before), frame(after));

    expect(delta.elements_appeared?.count).toBe(2);
    expect(delta.elements_appeared?.sample).toEqual([
      { role: 'option', name: 'Dallas' },
      { role: 'option', name: 'Denver' },
    ]);
    expect(delta.elements_appeared?.sample_truncated).toBeUndefined();
    expect(delta.elements_vanished).toBeUndefined();
  });

  it('keeps the count definite while the sample is capped', () => {
    const before: RawInteractable[] = [];
    const after = Array.from({ length: DELTA_SAMPLE_CAP + 7 }, (_, index) =>
      entry({ role: 'option', name: `Option ${index}` }),
    );

    const delta = diffFingerprints(frame(before), frame(after));

    expect(delta.elements_appeared?.count).toBe(DELTA_SAMPLE_CAP + 7);
    expect(delta.elements_appeared?.sample).toHaveLength(DELTA_SAMPLE_CAP);
    expect(delta.elements_appeared?.sample_truncated).toBe(true);
  });

  it('counts vanished elements as a multiset, not as a set of names', () => {
    const before = [
      entry({ role: 'option', name: 'Result' }),
      entry({ role: 'option', name: 'Result' }),
      entry({ role: 'option', name: 'Result' }),
    ];
    const after = [entry({ role: 'option', name: 'Result' })];

    const delta = diffFingerprints(frame(before), frame(after));

    expect(delta.elements_vanished?.count).toBe(2);
  });

  it('reports a dialog opening exactly once', () => {
    const consent = { role: 'dialog', name: 'Cookie consent' };
    const before = [entry({ name: 'Search' })];
    const after = [
      entry({ name: 'Search' }),
      entry({ name: 'Accept', scope: 'dialog', container: consent }),
      entry({ name: 'Decline', scope: 'dialog', container: consent }),
    ];

    const delta = diffFingerprints(frame(before), frame(after));

    expect(delta.dialogs_opened).toEqual([consent]);
    expect(delta.dialogs_closed).toBeUndefined();
  });

  it('reports a dialog closing exactly once', () => {
    const consent = { role: 'dialog', name: 'Cookie consent' };
    const before = [entry({ name: 'Accept', scope: 'dialog', container: consent })];
    const after = [entry({ name: 'Search' })];

    const delta = diffFingerprints(frame(before), frame(after));

    expect(delta.dialogs_closed).toEqual([consent]);
    expect(delta.dialogs_opened).toBeUndefined();
  });

  it('caps the dialog lists', () => {
    const after = Array.from({ length: DELTA_DIALOG_CAP + 4 }, (_, index) =>
      entry({
        name: `Control ${index}`,
        scope: 'dialog',
        container: { role: 'dialog', name: `Panel ${index}` },
      }),
    );

    const delta = diffFingerprints(frame([]), frame(after));

    expect(delta.dialogs_opened).toHaveLength(DELTA_DIALOG_CAP);
  });

  it('reports focus moving between two scanned controls', () => {
    const before = [entry({ role: 'textbox', name: 'Destination', focused: true })];
    const after = [
      entry({ role: 'textbox', name: 'Destination' }),
      entry({ role: 'option', name: 'Dallas', focused: true }),
    ];

    const delta = diffFingerprints(frame(before), frame(after));

    expect(delta.focus_moved).toEqual({
      from: { role: 'textbox', name: 'Destination' },
      to: { role: 'option', name: 'Dallas' },
    });
  });

  it('omits the side where focus was not on a scanned candidate', () => {
    const before = [entry({ role: 'textbox', name: 'Destination', focused: true })];
    const after = [entry({ role: 'textbox', name: 'Destination' })];

    const delta = diffFingerprints(frame(before), frame(after));

    expect(delta.focus_moved).toEqual({ from: { role: 'textbox', name: 'Destination' } });
    expect(delta.focus_moved).not.toHaveProperty('to');
  });

  it('says nothing about focus when it did not move', () => {
    const entries = [entry({ role: 'textbox', name: 'Destination', focused: true })];

    expect(diffFingerprints(frame(entries), frame(entries)).focus_moved).toBeUndefined();
  });

  it('reports url and title changes on their own evidence', () => {
    const delta = diffFingerprints(
      frame([], { url: 'https://example.test/a', title: 'A' }),
      frame([], { url: 'https://example.test/b', title: 'B' }),
    );

    expect(delta.url_changed).toEqual({
      from: 'https://example.test/a',
      to: 'https://example.test/b',
    });
    expect(delta.title_changed).toEqual({ from: 'A', to: 'B' });
  });

  describe('completeness', () => {
    it('refuses element and focus claims across a replaced document', () => {
      const before = frame([entry({ name: 'Search', focused: true })], {
        epoch: 'y1',
        url: 'https://example.test/a',
      });
      const after = frame([entry({ role: 'link', name: 'Home' })], {
        epoch: 'y2',
        url: 'https://example.test/b',
      });

      const delta = diffFingerprints(before, after);

      expect(delta.complete).toBe(false);
      expect(delta.incomplete).toEqual(['document-replaced']);
      expect(delta.url_changed).toBeDefined();
      expect(delta.elements_appeared).toBeUndefined();
      expect(delta.elements_vanished).toBeUndefined();
      expect(delta.focus_moved).toBeUndefined();
    });

    it('treats a same-document route change as fully comparable', () => {
      const before = frame([entry({ name: 'Search' })], { url: 'https://example.test/a' });
      const after = frame([entry({ name: 'Search' }), entry({ name: 'Filter' })], {
        url: 'https://example.test/a#results',
      });

      const delta = diffFingerprints(before, after);

      expect(delta.incomplete).toBeUndefined();
      expect(delta.elements_appeared?.count).toBe(1);
    });

    it('makes no replacement claim when neither frame could be stamped', () => {
      const entries = [entry({ name: 'Search' })];

      const delta = diffFingerprints(
        frame(entries, { epoch: null }),
        frame(entries, { epoch: null }),
      );

      expect(delta.incomplete).toBeUndefined();
    });

    it('refuses element counts when either frame was truncated', () => {
      const many = Array.from({ length: FINGERPRINT_MAX_ENTRIES + 1 }, (_, index) =>
        entry({ name: `item-${index}` }),
      );

      const delta = diffFingerprints(frame([entry({ name: 'Search' })]), frame(many));

      expect(delta.complete).toBe(false);
      expect(delta.incomplete).toEqual(['fingerprint-truncated']);
      expect(delta.elements_appeared).toBeUndefined();
      expect(delta.elements_vanished).toBeUndefined();
    });

    it('refuses elements, dialogs and focus when either scan degraded', () => {
      const before = frame([
        entry({ name: 'Accept', scope: 'dialog', container: { role: 'dialog', name: 'Consent' } }),
        entry({ name: 'Search', focused: true }),
      ]);
      const after = frame([], { degraded: true });

      const delta = diffFingerprints(before, after);

      expect(delta.complete).toBe(false);
      expect(delta.incomplete).toEqual(['scan-degraded']);
      expect(delta.elements_vanished).toBeUndefined();
      expect(delta.dialogs_closed).toBeUndefined();
      expect(delta.focus_moved).toBeUndefined();
    });

    it('reports every bound that applies, in a fixed order', () => {
      const many = Array.from({ length: FINGERPRINT_MAX_ENTRIES + 1 }, (_, index) =>
        entry({ name: `item-${index}` }),
      );

      const delta = diffFingerprints(
        frame(many, { epoch: 'y1' }),
        frame([], { epoch: 'y2', degraded: true }),
      );

      expect(delta.incomplete).toEqual([
        'document-replaced',
        'fingerprint-truncated',
        'scan-degraded',
      ]);
    });

    it('never emits `complete` and `incomplete` apart', () => {
      const cases: readonly ObservationFingerprint[][] = [
        [frame([]), frame([])],
        [frame([entry()]), frame([])],
        [frame([], { epoch: 'y1' }), frame([], { epoch: 'y2' })],
        [frame([]), frame([], { degraded: true })],
      ];

      for (const [before, after] of cases) {
        const delta = diffFingerprints(before!, after!);
        expect('complete' in delta).toBe('incomplete' in delta);
      }
    });
  });

  describe('bounds', () => {
    it('serializes a pathological page under DELTA_MAX_BYTES', () => {
      const long = 'n'.repeat(IDENTITY_PART_MAX_CHARS);
      const after = [
        ...Array.from({ length: 300 }, (_, index) =>
          entry({ role: 'option', name: `${long}-${index}` }),
        ),
        ...Array.from({ length: 40 }, (_, index) =>
          entry({
            name: `${long}-control-${index}`,
            scope: 'dialog',
            container: { role: 'dialog', name: `${long}-panel-${index}` },
          }),
        ),
      ];

      const delta = diffFingerprints(frame([]), frame(after));

      expect(deltaBytes(delta)).toBeLessThanOrEqual(DELTA_MAX_BYTES);
      // Trimming a sample never costs the definite count it was sampling.
      expect(delta.elements_appeared?.count).toBe(340);
    });

    it('keeps an ordinary delta far under the bound', () => {
      const delta = diffFingerprints(
        frame([entry({ name: 'Search' })]),
        frame([
          entry({ name: 'Search' }),
          entry({
            name: 'Accept',
            scope: 'dialog',
            container: { role: 'dialog', name: 'Cookie consent' },
          }),
        ]),
      );

      expect(deltaBytes(delta)).toBeLessThan(DELTA_MAX_BYTES / 4);
    });

    it('reports zero-ish bytes for an empty block', () => {
      expect(deltaBytes({})).toBe(2);
    });
  });
});
