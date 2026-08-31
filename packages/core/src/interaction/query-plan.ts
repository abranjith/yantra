/**
 * Shape the question a widget is asked — the WHAT rung.
 *
 * A suggestion list answers the query it is given. Rung after rung of *how* to
 * type cannot help a widget that will never answer the query, and the run that
 * motivated this work spent its worst call obeying a hint to re-type a full
 * offered label — "San Jose Mineta International Airport (SJC)" — into a list
 * that matches on leading characters and therefore matched nothing at all.
 *
 * This module is deliberately **pure string and ranking logic with no
 * widget-layer imports**. It needs no port, no DOM, and no fixture to test, and
 * keeping it that way is what stops the ranking rule below from acquiring a
 * second implementation inside a driver.
 */

import { MATCH_TIERS, type MatchTier } from './resolution.js';
import { normalizeText } from './types.js';

/** One query form in an ordered plan. */
export interface QueryForm {
  readonly kind: 'as-given' | 'code-token' | 'prefix-retreat';
  /** The text to actually type for this form. */
  readonly text: string;
}

/**
 * How long a retreated prefix may be before it stops being a retreat.
 *
 * Twelve characters is comfortably inside what a prefix matcher will answer
 * while still carrying more than one word of a place name, which is what makes
 * the retreat distinguishing rather than merely short.
 */
export const PREFIX_RETREAT_MAX_CHARS = 12;

/** Characters that end a word for the purposes of a retreat or a prefix. */
const WORD_SEPARATOR = /[\s,;/|(-]/u;

/** Shortest code token worth trying on its own. */
const CODE_TOKEN_MIN = 3;
/** Longest run of capitals still readable as a code rather than a shout. */
const CODE_TOKEN_MAX = 5;

/**
 * An uppercase short token standing alone in the request.
 *
 * The shape the `code-to-label-typeahead` fixture covers: a value that carries
 * its own machine identifier, which a widget will very often answer when it
 * will not answer the prose around it.
 */
const CODE_TOKEN_RE = new RegExp(
  `(?<![A-Za-z0-9])[A-Z][A-Z0-9]{${CODE_TOKEN_MIN - 1},${CODE_TOKEN_MAX - 1}}(?![A-Za-z0-9])`,
  'g',
);

/**
 * The ordered plan of query forms for one requested value.
 *
 * **This generates; the driver consumes lazily.** All applicable forms are
 * returned up front because a pure function of a string cannot know what a page
 * offered — the driver walks them in order and stops at the first that yields
 * candidates. "Only used when earlier forms found nothing" is a consumption
 * rule, not an emission rule, and writing it as an emission rule is what would
 * force this module to hold a port.
 *
 * Forms whose text duplicates an earlier form are dropped: typing the identical
 * query twice and settling twice buys nothing but the budget it spends.
 */
export function shapeQuery(requested: string): readonly QueryForm[] {
  const asGiven = requested.trim();
  if (asGiven.length === 0) return [];

  const forms: QueryForm[] = [{ kind: 'as-given', text: asGiven }];

  const code = soleCodeToken(asGiven);
  if (code !== null) forms.push({ kind: 'code-token', text: code });

  const retreat = prefixRetreat(asGiven);
  if (retreat !== null) forms.push({ kind: 'prefix-retreat', text: retreat });

  const seen = new Set<string>();
  return forms.filter((form) => {
    const key = normalizeText(form.text);
    if (key.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The one code token in the request, or null.
 *
 * Exactly one, never a choice among several. A request carrying two codes is a
 * page this cannot read, and guessing which one the widget wants would put a
 * value the caller never asked for into a field — the same discipline the
 * editee rung and the tie-break ladder already apply.
 */
function soleCodeToken(requested: string): string | null {
  const matches = requested.match(CODE_TOKEN_RE) ?? [];
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0]! : null;
}

/**
 * The longest leading run of the request that stays under the length bound.
 *
 * Cut back to a word boundary, so the retreat is text a human wrote rather than
 * a value sliced mid-syllable, and returned only when it is genuinely shorter
 * than the request — a short value has nothing to retreat from.
 */
function prefixRetreat(requested: string): string | null {
  if (requested.length <= PREFIX_RETREAT_MAX_CHARS) return null;
  const window = requested.slice(0, PREFIX_RETREAT_MAX_CHARS + 1);
  // The *last* boundary inside the window, not the first: retreating to "San"
  // when "San Jose" fits throws away the word that does the distinguishing.
  const boundary = lastBoundary(window);
  const cut =
    boundary > 0 ? window.slice(0, boundary) : requested.slice(0, PREFIX_RETREAT_MAX_CHARS);
  const trimmed = cut.trim();
  return trimmed.length > 0 && trimmed.length < requested.length ? trimmed : null;
}

/** Index of the last word separator in `value`, or -1. */
function lastBoundary(value: string): number {
  for (let index = value.length - 1; index > 0; index -= 1) {
    if (WORD_SEPARATOR.test(value[index]!)) return index;
  }
  return -1;
}

/**
 * A prefix of `label` long enough to tell it apart from everything else offered.
 *
 * This is what makes the offered-label hint honest. A caller told to "re-issue
 * with one of those strings" must not be answered by an engine that retypes the
 * whole label into a prefix matcher, which matches nothing; it types the
 * shortest leading run that still picks out one entry, and clicks the entry
 * whose full name is the label.
 *
 * @param label - The offered label to select.
 * @param others - The rest of what the widget offered, so the prefix can be
 *   grown past a shared opening ("San Jose, CA" vs "San Jose, Costa Rica").
 */
export function distinguishingPrefix(label: string, others: readonly string[] = []): string {
  const trimmed = label.trim();
  if (trimmed.length === 0) return trimmed;
  const rivals = others
    .map((other) => other.trim())
    .filter((other) => other.length > 0 && normalizeText(other) !== normalizeText(trimmed));

  let length = Math.min(PREFIX_RETREAT_MAX_CHARS, trimmed.length);
  for (const rival of rivals) {
    length = Math.max(length, sharedPrefixLength(trimmed, rival) + 1);
  }
  if (length >= trimmed.length) return trimmed;

  // Grow to the next word boundary rather than stopping mid-word: a matcher
  // fed half a word answers with the entries that merely start the same way,
  // and the retreat stops being distinguishing at exactly the wrong moment.
  const boundary = trimmed.slice(length).search(WORD_SEPARATOR);
  const cut = boundary === -1 ? trimmed : trimmed.slice(0, length + boundary);
  return cut.trim();
}

/** How many leading characters two strings share, case-insensitively. */
function sharedPrefixLength(left: string, right: string): number {
  const a = left.toLocaleLowerCase();
  const b = right.toLocaleLowerCase();
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

/** The minimum an option must expose to be ranked. */
export interface RankableOption {
  readonly name: string;
  readonly disabled?: boolean;
}

/** Result of ranking what a widget offered against what was requested. */
export type QueryRank<TOption> =
  | { readonly kind: 'match'; readonly candidate: TOption }
  | { readonly kind: 'ambiguous'; readonly offered: readonly string[] }
  | { readonly kind: 'none'; readonly offered: readonly string[] };

/** How many offered labels are ever reported back; page text, so it is capped. */
export const MAX_RANKED_OFFERED = 10;

/**
 * Rank offered options against the **full requested value**.
 *
 * The invariant that matters, and the reason this is the single ranking entry
 * point rather than a helper: ranking never compares against the shortened text
 * that was typed. Typing "San Jose Min" and ranking against "San Jose Mineta
 * International Airport (SJC)" is what lets a prefix matcher be queried and
 * still resolved correctly — and ranking against the typed prefix instead would
 * tie every entry that starts the same way and hand the caller a choice it
 * already made.
 *
 * Deliberately a different question from `resolveInteractable`: that one asks
 * which node the caller meant, and settles duplicates by document order. This
 * one asks which offer answers the request, where an unresolved tie is a real
 * choice belonging to the caller and is never settled by position.
 */
export function rankAgainstRequested<TOption extends RankableOption>(
  candidates: readonly TOption[],
  requested: string,
): QueryRank<TOption> {
  const usable = candidates.filter(
    (candidate) => candidate.disabled !== true && candidate.name.trim().length > 0,
  );
  const wanted = normalizeText(requested);
  const wantedTokens = wanted.split(' ').filter(Boolean);
  const offered = usable.slice(0, MAX_RANKED_OFFERED).map((candidate) => candidate.name);
  if (wanted.length === 0) return { kind: 'none', offered };

  for (const tier of MATCH_TIERS) {
    const hits = usable.filter((candidate) =>
      matchesAtTier(candidate.name, wanted, wantedTokens, tier),
    );
    if (hits.length === 0) continue;
    if (hits.length > 1) {
      return {
        kind: 'ambiguous',
        offered: hits.slice(0, MAX_RANKED_OFFERED).map((candidate) => candidate.name),
      };
    }
    return { kind: 'match', candidate: hits[0]! };
  }
  return { kind: 'none', offered };
}

/** One option name against the request, at one tier of the shared ladder. */
function matchesAtTier(
  name: string,
  wanted: string,
  wantedTokens: readonly string[],
  tier: Exclude<MatchTier, 'ref'>,
): boolean {
  const actual = normalizeText(name);
  switch (tier) {
    case 'exact':
      return actual === wanted;
    case 'prefix':
      return actual.startsWith(wanted);
    case 'all-tokens': {
      if (wantedTokens.length === 0) return false;
      const tokens = new Set(actual.split(' ').filter(Boolean));
      return wantedTokens.every((token) => tokens.has(token));
    }
    case 'substring':
      return actual.includes(wanted);
  }
}
