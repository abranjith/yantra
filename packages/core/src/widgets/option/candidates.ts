import {
  MAX_RANKED_OFFERED,
  normalizeText,
  rankAgainstRequested,
} from '../../interaction/index.js';
import type { WidgetContainer } from '../open-state.js';
import { withTag } from '../tagging.js';
import type { WidgetPort } from '../types.js';

/** Serializable option discovered inside a widget container. */
export interface WidgetCandidate {
  readonly name: string;
  readonly role: string;
  readonly disabled: boolean;
  readonly path: readonly number[];
  readonly group?: string | null;
}

/** Result of deterministic candidate ranking. */
export type WidgetCandidateRank =
  | { readonly kind: 'match'; readonly candidate: WidgetCandidate }
  | { readonly kind: 'ambiguous'; readonly offered: readonly string[] }
  | { readonly kind: 'none'; readonly offered: readonly string[] };

/** Collect clickable or homogeneous named children from a resolved popup. */
export function collectCandidates(
  port: WidgetPort,
  container: WidgetContainer,
): Promise<readonly WidgetCandidate[]> {
  return port.evaluate((containerPath) => {
    const fromPath = (path: readonly number[]): Element | null => {
      let current: Element | null = document.documentElement;
      for (const index of path) current = current?.children.item(index) ?? null;
      return current;
    };
    const toPath = (candidate: Element): number[] => {
      const result: number[] = [];
      let current: Element | null = candidate;
      while (current && current !== document.documentElement) {
        const parent: Element | null = current.parentElement;
        if (!parent) return [];
        result.unshift(Array.prototype.indexOf.call(parent.children, current));
        current = parent;
      }
      return result;
    };
    const nameOf = (candidate: Element): string => {
      const aria = candidate.getAttribute('aria-label')?.trim();
      if (aria) return aria.replace(/\s+/g, ' ');
      const labelledBy = candidate.getAttribute('aria-labelledby');
      if (labelledBy) {
        const label = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ');
        if (label) return label.replace(/\s+/g, ' ');
      }
      return (candidate.textContent ?? '').replace(/\s+/g, ' ').trim();
    };
    const roleOf = (candidate: Element): string => {
      const explicit = candidate.getAttribute('role');
      if (explicit) return explicit;
      const tag = candidate.tagName.toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'a') return 'link';
      return 'option';
    };
    const visible = (candidate: Element): boolean => {
      if (!(candidate instanceof HTMLElement) || candidate.hidden) return false;
      const style = window.getComputedStyle(candidate);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const root = fromPath(containerPath);
    if (!(root instanceof HTMLElement)) return [];
    const primarySelector =
      '[role="option"],button,a[href],[role="menuitem"],li[onclick],li[tabindex]';
    const primary = Array.from(root.querySelectorAll(primarySelector)).filter(visible);
    const namedChildren = Array.from(root.children).filter(
      (candidate) => visible(candidate) && nameOf(candidate).length > 0,
    );
    const source = primary.length > 0 ? primary : namedChildren.length >= 2 ? namedChildren : [];
    const unique = [...new Set(source)].filter((candidate) => {
      return !source.some(
        (other) =>
          other !== candidate && candidate.contains(other) && nameOf(other) === nameOf(candidate),
      );
    });
    return unique
      .map((candidate) => ({
        name: nameOf(candidate),
        role: roleOf(candidate),
        disabled:
          candidate.getAttribute('aria-disabled') === 'true' ||
          ('disabled' in candidate && Boolean((candidate as HTMLButtonElement).disabled)),
        path: toPath(candidate),
      }))
      .filter((candidate) => candidate.name.length > 0 && candidate.path.length > 0);
  }, container.path);
}

/**
 * Rank offered options against what the caller asked for.
 *
 * A thin adapter over the one ranking implementation in `interaction/`, kept as
 * a named export because every widget caller already addresses it by this name.
 * The logic lives one layer down so the combobox driver and the plain-text path
 * cannot drift into two ideas of which offer answers a request — which is the
 * defect the WHAT rung exists to remove, not to reproduce.
 *
 * `requested` is the **full requested value**, never the possibly-shortened
 * text that was typed to provoke the list. See `rankAgainstRequested`.
 */
export function rankCandidate(
  candidates: readonly WidgetCandidate[],
  requested: string,
): WidgetCandidateRank {
  return rankAgainstRequested(candidates, requested);
}

/**
 * Resolve a structural candidate to a fresh ref and click through the port.
 *
 * The group read in-page and the group the observation reports are computed by
 * different code and legitimately disagree — a calendar panel captioned by a
 * plain `<span>` is named for its month here and for its enclosing dialog
 * there. Group is therefore a tie-breaker, not a filter: a name that is unique
 * across the whole observation identifies the element on its own, and only a
 * genuinely ambiguous name needs the group to settle it. Nothing is ever
 * clicked on a tie; that falls through to the tagging path below.
 */
export async function clickCandidate(port: WidgetPort, candidate: WidgetCandidate): Promise<void> {
  const observation = await port.observe({ cap: 400, trackDigest: false });
  const named = observation.interactables.filter(
    (entry) => normalize(entry.name) === normalize(candidate.name),
  );
  const grouped =
    candidate.group === undefined || candidate.group === null
      ? []
      : named.filter((entry) => normalize(entry.group ?? '') === normalize(candidate.group!));
  const pool = grouped.length > 0 ? grouped : named;
  const matchingRefs: string[] = [];
  for (const entry of pool) {
    if (pool.length === 1) {
      matchingRefs.push(entry.ref);
      break;
    }
    const same = await port.evaluateOn(
      entry.ref,
      (element, wantedPath) => {
        let current: Element | null = document.documentElement;
        for (const index of wantedPath) current = current?.children.item(index) ?? null;
        return current === element;
      },
      candidate.path,
    );
    if (same) matchingRefs.push(entry.ref);
  }
  if (matchingRefs.length === 1) {
    await port.click(matchingRefs[0]!);
    return;
  }
  await withTag(
    port,
    (attribute, token, wantedPath) => {
      let current: Element | null = document.documentElement;
      for (const index of wantedPath) current = current?.children.item(index) ?? null;
      if (!current) return false;
      current.setAttribute(attribute, token);
      return true;
    },
    (ref) => port.click(ref).then(() => undefined),
    candidate.path,
  );
}

/** Normalized text form used by ranking and commit checks. */
export function normalizeCandidateText(value: string): string {
  return normalize(value);
}

/** How many offered labels a widget result ever carries; page text, so capped. */
export const MAX_CANDIDATE_OFFERED = MAX_RANKED_OFFERED;

function normalize(value: string): string {
  return normalizeText(value);
}
