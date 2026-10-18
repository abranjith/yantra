import {
  SENSITIVE_AUTOCOMPLETE_TOKENS,
  withheldDetails,
  type CommitMatch,
  type CommittedValue,
  type WithheldReason,
  type WithheldValue,
} from '../interaction/protected-value.js';

import {
  widgetFailure,
  type WidgetFailure,
  type WidgetIntent,
  type WidgetPort,
  type WidgetTarget,
} from './types.js';

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

const TEXTUAL_DATE_LOCALES = [
  'en-US',
  'en-GB',
  'fr-FR',
  'de-DE',
  'es-ES',
  'it-IT',
  'pt-BR',
  'nl-NL',
  'pl-PL',
  'sv-SE',
  'da-DK',
  'nb-NO',
  'fi-FI',
  'cs-CZ',
  'tr-TR',
  'ja-JP',
  'ko-KR',
  'zh-CN',
] as const;

interface ParsedDatePart {
  readonly year: number | null;
  readonly month: number;
  readonly day: number;
}

/** What a committed read compares against, and which value it reads. */
export interface ReadCommittedOptions {
  /**
   * The text the control should hold.
   *
   * Used only for a withheld control, where it is compared **inside the page**
   * and only the verdict comes back. Passing the caller's own value to the
   * page is no new exposure: the same value was just typed into it.
   */
  readonly expected?: string;
  /**
   * `committed` (the default) reads every source a control offers about its
   * value. `raw` reads only the box itself — `value`, or its text — and asks
   * "did the characters land", where a picker's accessible label answering on
   * the box's behalf would mask the very truncation being looked for.
   */
  readonly source?: 'committed' | 'raw';
}

/**
 * Read the trigger's current value, typed by whether it may be disclosed.
 *
 * The **only** in-page reader of a control's value in the fill path, so the
 * protected-control predicate and the match comparator each exist once in page
 * code. A protected control returns `withheld` with its presence and — given
 * `expected` — an in-page {@link CommitMatch} verdict. Its raw value is never a
 * return value, so nothing downstream of this function can leak it.
 *
 * For anything that is not a form element there is no single place the value
 * lives, so every source the control offers about itself is returned together —
 * `aria-valuetext`, then its accessible name, then its rendered text — rather
 * than the first non-empty one. Stopping at the accessible name is what made a
 * committed range read as uncommitted on pickers that keep a *fixed* label:
 * KAYAK's date trigger is permanently labelled "Select start date from calendar
 * input" and shows the chosen day as its text ("Sun 9/6"), so the one source
 * consulted was the one guaranteed never to change. The opposite shape — an
 * icon-only cell whose date is only in `aria-label` — is equally common, and
 * including both is what serves them both.
 */
export async function readCommittedValue(
  port: WidgetPort,
  target: WidgetTarget,
  options: ReadCommittedOptions = {},
): Promise<CommittedValue> {
  return port.evaluateOn(
    target.ref,
    (element, sensitiveTokens, expected, source): CommittedValue => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? '').replace(/\s+/g, ' ').trim();
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        // The in-page twin of `classifyWithheld`.
        const tokens = (element.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/u);
        const reason: WithheldReason | null = element.matches('input[type="password"]')
          ? 'password'
          : tokens.some((token) => sensitiveTokens.includes(token))
            ? 'autocomplete'
            : element.hasAttribute('data-yantra-secret')
              ? 'secret_marker'
              : null;
        if (reason === null) return { kind: 'disclosed', text: normalize(element.value) };
        const actual = element.value;
        if (expected === null) {
          return { kind: 'withheld', reason, present: actual.length > 0, match: null };
        }
        // The in-page twin of `classifyCommitMatch`. `formattingKey` and the
        // subsequence test re-implement the typing ladder's, because a
        // serialized function cannot import them; a parity test holds them
        // to the same answers.
        const formattingKey = (value: string): string =>
          value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
        const folded = (value: string): string =>
          value
            .toLocaleLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const truncated = (): boolean => {
          const kept = folded(actual);
          const wanted = folded(expected);
          if (wanted.length === 0) return false;
          if (kept.length === 0) return true;
          if (kept.length >= wanted.length) return false;
          let cursor = 0;
          for (const character of wanted) {
            if (character === kept[cursor]) cursor += 1;
            if (cursor === kept.length) return true;
          }
          return cursor === kept.length;
        };
        const match: CommitMatch =
          actual.length === 0
            ? 'empty'
            : actual === expected
              ? 'exact'
              : formattingKey(expected).length > 0 &&
                  formattingKey(actual) === formattingKey(expected)
                ? 'reformatted'
                : truncated()
                  ? 'truncated'
                  : 'different';
        return { kind: 'withheld', reason, present: actual.length > 0, match };
      }
      if (source === 'raw') return { kind: 'disclosed', text: normalize(element.textContent) };
      if (element instanceof HTMLSelectElement) {
        const selected = element.selectedOptions[0];
        const label = selected?.label ?? '';
        return {
          kind: 'disclosed',
          text: normalize(label.length > 0 ? label : (selected?.text ?? element.value)),
        };
      }
      const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
      const sources = [
        element.getAttribute('aria-valuetext'),
        element.getAttribute('aria-label'),
        labelledBy.map((id) => document.getElementById(id)?.textContent ?? '').join(' '),
        element.textContent,
      ].map(normalize);
      const parts: string[] = [];
      for (const text of sources) {
        // Skip anything already said: a control whose label and text agree must
        // not report its value twice, or an ordered range check reading "Sep 6
        // Sep 6" would accept it as the range Sep 6 → Sep 6.
        if (text.length === 0) continue;
        if (parts.some((part) => part.includes(text) || text.includes(part))) continue;
        parts.push(text);
      }
      return { kind: 'disclosed', text: parts.join(' ') };
    },
    SENSITIVE_AUTOCOMPLETE_TOKENS,
    options.expected ?? null,
    options.source ?? 'committed',
  );
}

/** A committed read a date or option driver can compare, or why it cannot. */
export type ComparableRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly failure: WidgetFailure };

/**
 * Read a control's committed text for comparison with a date or a choice.
 *
 * A protected control has no text to compare, and comparing `''` against the
 * intent would report a value it never disclosed as lost. It fails instead,
 * naming the withheld state and nothing of the value.
 */
export async function readComparable(
  port: WidgetPort,
  target: WidgetTarget,
): Promise<ComparableRead> {
  const value = await readCommittedValue(port, target);
  return value.kind === 'disclosed'
    ? { ok: true, text: value.text }
    : { ok: false, failure: withheldReadFailure(target, value) };
}

/**
 * The `value-withheld` failure: a date or choice cannot be confirmed from a
 * control that withholds its contents.
 *
 * Not retryable as sent — the same call reads the same withheld control — and
 * the hint names the move that works: sending the value as plain text.
 */
export function withheldReadFailure(target: WidgetTarget, value: WithheldValue): WidgetFailure {
  return widgetFailure(
    'WIDGET_NOT_COMMITTED',
    'value-withheld',
    `The "${target.name}" control withholds its contents, so the date or choice it holds cannot be confirmed.`,
    { ...withheldDetails(value) },
    false,
  );
}

/**
 * Compare a committed value with the option the widget was actually made to
 * choose, rather than with the text that was typed to find it.
 *
 * This is the whole point of recording `chosen`. A search field asked for an
 * airport code offers a city name and commits that; a store locator asked for a
 * postcode commits a branch. In every such case the widget has resolved the
 * request to something it genuinely offers, and the right question is "does the
 * field hold the option we clicked", not "does the field contain what we
 * typed" — which is the question that reported a landed fill as a failure.
 *
 * Containment runs both ways because a control legitimately renders more than
 * the label ("Dallas (DFW), United States" for an option reading "Dallas") or
 * less of it ("Dallas" for "Dallas Fort Worth International").
 */
export function matchesCommitment(committed: string, chosenLabel: string): boolean {
  const actual = normalizeOption(committed);
  const chosen = normalizeOption(chosenLabel);
  if (actual.length === 0 || chosen.length === 0) return false;
  return actual.includes(chosen) || chosen.includes(actual);
}

/** Compare a rendered committed value with the semantic intent. */
export function matchesIntent(committed: string, intent: WidgetIntent): boolean {
  if (intent.kind === 'option') {
    const actual = normalizeOption(committed);
    const wanted = normalizeOption(intent.value);
    return (
      actual.length > 0 && wanted.length > 0 && (actual.includes(wanted) || wanted.includes(actual))
    );
  }
  const expected =
    intent.kind === 'date' ? [parseIso(intent.date)] : [parseIso(intent.from), parseIso(intent.to)];
  if (expected.some((part) => part === null)) return false;
  const actual = parseRenderedDates(committed);
  let cursor = 0;
  let parsedMatch = true;
  for (const wanted of expected) {
    if (wanted === null) return false;
    const found = actual.findIndex(
      (part, index) =>
        index >= cursor &&
        part.month === wanted.month &&
        part.day === wanted.day &&
        (part.year === null || part.year === wanted.year),
    );
    if (found < 0) {
      parsedMatch = false;
      break;
    }
    cursor = found + 1;
  }
  if (parsedMatch) return true;
  return matchesIntlRenderedDates(
    committed,
    expected.filter((part): part is ParsedDatePart => part !== null),
  );
}

function matchesIntlRenderedDates(committed: string, expected: readonly ParsedDatePart[]): boolean {
  const normalized = normalizeDateText(committed);
  // Compact pickers render "Sun, Sep 6" and a year the widget never shows
  // cannot be required. A year it *does* show still has to agree, so the
  // year-less forms are offered only when there is no year to disagree with.
  const rendersYear = /\b\d{4}\b/.test(committed);
  let cursor = 0;
  for (const part of expected) {
    const date = new Date(Date.UTC(part.year!, part.month - 1, part.day));
    const variants = new Set<string>();
    for (const locale of TEXTUAL_DATE_LOCALES) {
      for (const month of ['long', 'short'] as const) {
        for (const includeYear of rendersYear ? [true] : [true, false]) {
          variants.add(
            normalizeDateText(
              new Intl.DateTimeFormat(locale, {
                day: 'numeric',
                month,
                ...(includeYear ? { year: 'numeric' as const } : {}),
                timeZone: 'UTC',
              }).format(date),
            ),
          );
        }
      }
    }
    const found = [...variants]
      .map((variant) => normalized.indexOf(variant, cursor))
      .filter((index) => index >= cursor)
      .sort((left, right) => left - right)[0];
    if (found === undefined) return false;
    cursor = found + 1;
  }
  return true;
}

function parseIso(value: string): ParsedDatePart | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function parseRenderedDates(value: string): ParsedDatePart[] {
  const found: (ParsedDatePart & { readonly index: number })[] = [];
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  for (const match of value.matchAll(iso)) {
    const parsed = parseIso(match[0]);
    if (parsed) found.push({ ...parsed, index: match.index ?? 0 });
  }
  const monthPattern = MONTHS.map((month) => `${month}|${month.slice(0, 3)}`).join('|');
  const named = new RegExp(
    `\\b(${monthPattern})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`,
    'gi',
  );
  for (const match of value.matchAll(named)) {
    const monthName = match[1]!.toLowerCase().slice(0, 3);
    const month = MONTHS.findIndex((entry) => entry.startsWith(monthName)) + 1;
    const day = Number(match[2]);
    const year = match[3] ? Number(match[3]) : null;
    if (month > 0 && day >= 1 && day <= 31) {
      found.push({ month, day, year, index: match.index ?? 0 });
    }
  }
  // A slashed numeric date carries no signal about its own field order, and the
  // page that rendered it is as likely to be day-first as month-first. Both
  // readings are offered so either order verifies; when only one is calendar-
  // valid (a leading 21 cannot be a month) that one stands alone.
  //
  // The year is optional for the same reason it is optional after a month name:
  // compact triggers render "Sun 9/6" and no year they never showed can be
  // required of them. Only `/` admits the short form — `1.5` is a number far
  // more often than it is a date — and the lookarounds keep it from carving a
  // second reading out of a full `9/6/2026`.
  const numeric = /(?<![\d/.])(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}))?(?![\d/.])/g;
  for (const match of value.matchAll(numeric)) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = match[3] === undefined ? null : Number(match[3]);
    if (year === null && !match[0].includes('/')) continue;
    const index = match.index ?? 0;
    for (const [month, day] of [
      [first, second],
      [second, first],
    ]) {
      if (month! < 1 || month! > 12 || day! < 1 || day! > 31) continue;
      if (found.some((part) => part.index === index && part.month === month && part.day === day)) {
        continue;
      }
      found.push({ month: month!, day: day!, year, index });
    }
  }
  return found.sort((left, right) => left.index - right.index);
}

function normalizeOption(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDateText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
