/**
 * One ranked resolver for "which element did the caller mean".
 *
 * Four near-identical implementations of this question existed — one in the
 * agent's form tools, one in the fill engine's re-acquisition path, one in
 * deterministic replay, and the name-matching half of option clicking — and
 * they had already drifted: three normalized punctuation and one did not, one
 * had a token tier and three did not. Unifying them is worth doing on its own,
 * but the reason it happens here is the tie-break ladder below, which every
 * caller needs and none of them had.
 *
 * The distinction that makes the ladder safe: choosing **which field the caller
 * meant** is a value decision and is still refused when it is genuinely
 * ambiguous — "Check-in" and "Check-out" share a prefix, and picking one fills
 * the wrong date while looking like success. Choosing **which live node is the
 * control already identified** is not a value decision, and refusing it is what
 * made an open picker's own duplicate trigger unaddressable.
 */

import type { AgentInteractable } from '../browser/agent-controller.js';
import type { WidgetTarget } from '../widgets/types.js';

import { normalizeText } from './types.js';

/** A literal opaque ref, as minted by `observe()`. */
export const REF_PATTERN = /^e[0-9]+$/;

/** How a query matched, strongest first. Matching stops at the first hit. */
export type MatchTier = 'ref' | 'exact' | 'prefix' | 'all-tokens' | 'substring';

/** Every tier in strength order, exported so ranking cannot drift from here. */
export const MATCH_TIERS: readonly Exclude<MatchTier, 'ref'>[] = [
  'exact',
  'prefix',
  'all-tokens',
  'substring',
];

/**
 * A rung of the tie-break ladder that narrowed a tied tier.
 *
 * Reported so a caller can see *why* one of several same-named controls was
 * chosen, rather than having to trust that it was.
 */
export type TieBreakRung =
  | 'enabled'
  | 'within-container'
  | 'preferred-role'
  | 'preferred-group'
  | 'same-name-and-role';

/** Inputs that let the ladder narrow a tie without guessing at intent. */
export interface ResolveInteractableOptions {
  /**
   * The control the caller already resolved once and is now re-finding.
   *
   * Together with `allowEquivalentCopies`, this proves the value decision was
   * already made and the caller is only re-finding its live node.
   */
  readonly preferred?: WidgetTarget;
  /**
   * Refs known to sit inside the widget container currently being operated.
   *
   * Supplied by the caller rather than computed here, so this function stays
   * pure and directly testable; the caller is the one holding a port.
   */
  readonly containedRefs?: ReadonlySet<string>;
  /**
   * Permit document order to choose between proven copies of an already
   * resolved control. Callers must set this only while re-acquiring a target
   * whose prior role, name, and group are available in {@link preferred}.
   */
  readonly allowEquivalentCopies?: boolean;
}

/** The outcome of resolving one query against one observation. */
export type Resolution =
  | {
      readonly kind: 'match';
      readonly entry: AgentInteractable;
      readonly tier: MatchTier;
      readonly tieBreak: readonly TieBreakRung[];
    }
  | {
      readonly kind: 'ambiguous';
      readonly tier: MatchTier;
      readonly offered: readonly AgentInteractable[];
    }
  | { readonly kind: 'none'; readonly offered: readonly AgentInteractable[] };

/**
 * Resolve a field name or `eNN` ref to exactly one interactable.
 *
 * Tiers are tried strongest-first and matching stops at the first tier with any
 * hit — it never keeps narrowing to escape a tie, because a query that matches
 * two things at one strength has not identified either of them.
 */
export function resolveInteractable(
  query: string,
  interactables: readonly AgentInteractable[],
  options: ResolveInteractableOptions = {},
): Resolution {
  const trimmed = query.trim();
  const named = interactables.filter((entry) => entry.name.trim().length > 0);
  if (trimmed.length === 0) return { kind: 'none', offered: named };

  if (REF_PATTERN.test(trimmed)) {
    const byRef = interactables.find((entry) => entry.ref === trimmed);
    return byRef
      ? { kind: 'match', entry: byRef, tier: 'ref', tieBreak: [] }
      : { kind: 'none', offered: named };
  }

  const wanted = normalizeText(trimmed);
  const wantedTokens = wanted.split(' ').filter(Boolean);
  for (const tier of MATCH_TIERS) {
    const hits = named.filter((entry) => matchesTier(entry.name, wanted, wantedTokens, tier));
    if (hits.length === 0) continue;
    return narrow(hits, tier, options);
  }
  return { kind: 'none', offered: named };
}

/** Whether one candidate name matches the query at a given tier. */
function matchesTier(
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

/**
 * Narrow a tied tier down the ladder, or report it as ambiguous.
 *
 * Each rung only ever *filters*, and only when it leaves something behind, so
 * the ladder can never invent a winner out of an empty set.
 */
function narrow(
  hits: readonly AgentInteractable[],
  tier: MatchTier,
  options: ResolveInteractableOptions,
): Resolution {
  const tieBreak: TieBreakRung[] = [];
  let pool = hits;
  if (pool.length === 1) return { kind: 'match', entry: pool[0]!, tier, tieBreak };

  const apply = (rung: TieBreakRung, next: readonly AgentInteractable[]): void => {
    if (next.length === 0 || next.length === pool.length) return;
    pool = next;
    tieBreak.push(rung);
  };

  // A disabled control cannot be what the caller wants to operate, so it loses
  // to an enabled one of the same name before anything else is considered.
  apply(
    'enabled',
    pool.filter((entry) => entry.disabled !== true),
  );
  if (pool.length === 1) return { kind: 'match', entry: pool[0]!, tier, tieBreak };

  if (options.containedRefs && options.containedRefs.size > 0) {
    const contained = options.containedRefs;
    apply(
      'within-container',
      pool.filter((entry) => contained.has(entry.ref)),
    );
    if (pool.length === 1) return { kind: 'match', entry: pool[0]!, tier, tieBreak };
  }

  if (options.preferred) {
    const preferred = options.preferred;
    apply(
      'preferred-role',
      pool.filter((entry) => entry.role === preferred.role),
    );
    if (pool.length === 1) return { kind: 'match', entry: pool[0]!, tier, tieBreak };
    apply(
      'preferred-group',
      pool.filter((entry) => (entry.group ?? null) === preferred.group),
    );
    if (pool.length === 1) return { kind: 'match', entry: pool[0]!, tier, tieBreak };
  }

  // THE SAFETY BOUNDARY. Document order settles a tie only for explicit
  // re-acquisition, and only when every survivor carries the same normalized
  // name, role, and group. Initial resolution never guesses from repeated
  // labels; opening a picker may mount a true copy, but separate forms may also
  // contain independent controls that look identical.
  //
  // Differently-named fields can never reach this rung: "Check-in" and
  // "Check-out" tie on the prefix tier, differ in name, and fall through to
  // `ambiguous` exactly as they always have. No value decision is ever guessed.
  const firstName = normalizeText(pool[0]!.name);
  const firstRole = pool[0]!.role;
  const firstGroup = pool[0]!.group ?? null;
  const copiesOfOneControl = pool.every(
    (entry) =>
      normalizeText(entry.name) === firstName &&
      entry.role === firstRole &&
      (entry.group ?? null) === firstGroup,
  );
  const matchesPreferredIdentity =
    options.preferred !== undefined &&
    normalizeText(options.preferred.name) === firstName &&
    options.preferred.role === firstRole &&
    options.preferred.group === firstGroup;
  if (options.allowEquivalentCopies === true && copiesOfOneControl && matchesPreferredIdentity) {
    tieBreak.push('same-name-and-role');
    return { kind: 'match', entry: pool[0]!, tier, tieBreak };
  }

  return { kind: 'ambiguous', tier, offered: pool };
}
