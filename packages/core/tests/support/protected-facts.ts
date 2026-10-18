import type {
  ProtectedControlFacts,
  WithheldReason,
} from '../../src/interaction/protected-value.js';

/** One row of the shared classification table; `expected` is what every copy must say. */
export interface WithheldFactsRow {
  readonly label: string;
  readonly facts: ProtectedControlFacts;
  readonly expected: WithheldReason | null;
}

/** Facts for an ordinary control, with the given overrides. */
export function protectedFacts(
  overrides: Partial<ProtectedControlFacts> = {},
): ProtectedControlFacts {
  return { passwordInput: false, autocomplete: '', secretMarker: false, ...overrides };
}

/**
 * The parity table every in-page copy of the predicate is checked against.
 *
 * A function shipped to the page by source cannot import the Node classifier,
 * so the scan, the committed read, and the replay port each carry their own
 * copy; this table is what holds them to one answer.
 */
export const WITHHELD_FACTS_TABLE: readonly WithheldFactsRow[] = [
  { label: 'ordinary text', facts: protectedFacts(), expected: null },
  { label: 'password', facts: protectedFacts({ passwordInput: true }), expected: 'password' },
  {
    label: 'card number',
    facts: protectedFacts({ autocomplete: 'cc-number' }),
    expected: 'autocomplete',
  },
  {
    label: 'secret marker',
    facts: protectedFacts({ secretMarker: true }),
    expected: 'secret_marker',
  },
  {
    label: 'password outranks autocomplete',
    facts: protectedFacts({ passwordInput: true, autocomplete: 'cc-number' }),
    expected: 'password',
  },
  {
    label: 'section-prefixed token',
    facts: protectedFacts({ autocomplete: 'section-pay cc-number' }),
    expected: 'autocomplete',
  },
  { label: 'card holder name', facts: protectedFacts({ autocomplete: 'cc-name' }), expected: null },
  {
    label: 'upper-case token',
    facts: protectedFacts({ autocomplete: 'ONE-TIME-CODE' }),
    expected: 'autocomplete',
  },
  {
    label: 'autocomplete outranks marker',
    facts: protectedFacts({ autocomplete: 'new-password', secretMarker: true }),
    expected: 'autocomplete',
  },
  { label: 'email', facts: protectedFacts({ autocomplete: 'email' }), expected: null },
  {
    label: 'ordinary token with marker',
    facts: protectedFacts({ autocomplete: 'tel', secretMarker: true }),
    expected: 'secret_marker',
  },
  {
    label: 'token prefix is not the token',
    facts: protectedFacts({ autocomplete: 'cc-number-extra cc-cscx' }),
    expected: null,
  },
];

/**
 * Markup for one row: an input carrying exactly the row's facts and `value`.
 *
 * Attribute-escaped minimally; rows and values are fixed test literals.
 */
export function protectedInputMarkup(row: WithheldFactsRow, value: string, extra = ''): string {
  const attributes = [
    `type="${row.facts.passwordInput ? 'password' : 'text'}"`,
    row.facts.autocomplete.length > 0 ? `autocomplete="${row.facts.autocomplete}"` : '',
    row.facts.secretMarker ? 'data-yantra-secret' : '',
    `aria-label="${row.label}"`,
    `value="${value}"`,
    extra,
  ].filter((attribute) => attribute.length > 0);
  return `<input ${attributes.join(' ')}>`;
}
