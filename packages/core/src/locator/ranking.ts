/// <reference lib="dom" />

/**
 * Record-time candidate ranking algorithm.
 *
 * Given a captured DOM element, produces the top-N candidates ranked by
 * stability + specificity. Called by the recorder (FEAT-008) to populate
 * each named locator's chain.
 *
 * Priority order (matches plan §7 architecture rules):
 *   1. data-testid   weight=1.00
 *   2. role+name     weight=0.90
 *   3. label-for     weight=0.75
 *   4. placeholder   weight=0.60
 *   5. unique CSS    weight=0.45
 *   6. relative      weight=0.30
 *   7. absolute XPath weight=0.10
 */

import { generateUniqueCss, isStableClassName } from './injected/css.js';
import { getAccessibleName, getRole } from './injected/role.js';
import { generateAbsoluteXpath } from './injected/xpath.js';
import type { CandidateRanking, LocatorIntent, RankedCandidate, RankingOptions } from './types.js';

const DEFAULT_TESTID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-qa', 'data-test'] as const;
const DEFAULT_TOP_N = 5;

/**
 * Ranks candidate locator strategies for a given element at record time.
 *
 * The ranking is deterministic: ties break by base weight, then by strategy
 * enum order. `Math.random()` is never used.
 *
 * @param element - The DOM element to generate candidates for
 * @param options - Optional topN cap and testid attribute aliases
 * @returns Ranked candidate list sorted by score descending
 *
 * @example
 * const ranking = rankCandidates(signInButton);
 * // ranking.candidates[0].intent.kind === 'testid' (if data-testid present)
 */
export function rankCandidates(element: Element, options: RankingOptions = {}): CandidateRanking {
  const topN = options.topN ?? DEFAULT_TOP_N;
  const testidAttrs = options.testidAttributes ?? DEFAULT_TESTID_ATTRIBUTES;
  const candidates: RankedCandidate[] = [];

  // 1. data-testid (base weight 1.00)
  for (const attr of testidAttrs) {
    const val = element.getAttribute(attr);
    if (val) {
      candidates.push({
        intent: { kind: 'testid', attribute: attr, value: val },
        score: 1.0,
        rationale: `${attr} attribute present`,
      });
      break; // first matching alias wins at this rank
    }
  }

  // 2. role + accessible name (base weight 0.90)
  const role = getRole(element);
  const accessibleName = getAccessibleName(element);
  if (role) {
    if (accessibleName) {
      // Exact name match scores slightly higher than regex
      candidates.push({
        intent: { kind: 'role', role, name: accessibleName, exact: true },
        score: 0.9 * 1.05,
        rationale: `role=${role} with exact name "${accessibleName}"`,
      });
    } else {
      candidates.push({
        intent: { kind: 'role', role },
        score: 0.9,
        rationale: `role=${role} without name constraint`,
      });
    }
  }

  // 3. label-for (base weight 0.75)
  const labelText = findLabelText(element);
  if (labelText) {
    candidates.push({
      intent: { kind: 'label', text: labelText, exact: true },
      score: 0.75,
      rationale: `label text "${labelText}"`,
    });
  }

  // 4. placeholder (base weight 0.60)
  const placeholder = element.getAttribute('placeholder');
  if (placeholder) {
    candidates.push({
      intent: { kind: 'placeholder', text: placeholder, exact: true },
      score: 0.6,
      rationale: `placeholder="${placeholder}"`,
    });
  }

  // 5. unique CSS (base weight 0.45)
  const css = generateUniqueCss(element);
  if (css !== null) {
    // Score boost for selectors with multiple stable classes
    const classCount = countStableClasses(element);
    const multiplier = classCount >= 2 ? 1.1 : 1.0;
    candidates.push({
      intent: { kind: 'css', selector: css },
      score: 0.45 * multiplier,
      rationale: `unique CSS selector (${classCount} stable class${classCount !== 1 ? 'es' : ''})`,
    });
  }

  // 6. relative anchor (base weight 0.30)
  const relativeIntent = buildRelativeIntent(element);
  if (relativeIntent) {
    candidates.push({
      intent: relativeIntent,
      score: 0.3,
      rationale: 'relative anchor (labeled-by or sibling relationship)',
    });
  }

  // 7. absolute XPath (base weight 0.10) — always available
  const xpath = generateAbsoluteXpath(element);
  candidates.push({
    intent: { kind: 'xpath', expression: xpath },
    score: 0.1,
    rationale: 'absolute XPath (last resort)',
  });

  // Sort descending by score, then by strategy enum order for ties
  candidates.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    // Tie-break by kind enum order (deterministic)
    return kindOrder(a.intent) - kindOrder(b.intent);
  });

  const topCandidates = candidates.slice(0, topN);

  return {
    target: {
      tagName: element.tagName.toLowerCase(),
      ...(accessibleName ? { accessibleName } : {}),
    },
    candidates: topCandidates,
  };
}

/** Fixed kind ordering for deterministic tie-breaking. */
function kindOrder(intent: LocatorIntent): number {
  const ORDER: Record<string, number> = {
    testid: 0,
    role: 1,
    label: 2,
    placeholder: 3,
    css: 4,
    relative: 5,
    xpath: 6,
    text: 7,
  };
  return ORDER[intent.kind] ?? 99;
}

/**
 * Finds the text of a <label> associated with this element, excluding the text
 * of any form controls nested inside it.
 *
 * Strictly read-only. The `label[for]` branch used to strip controls from the
 * *live* label while reading text from an unstripped clone — so it both
 * returned the wrong text and deleted real inputs from the page. Harmless while
 * ranking was unused; now that it runs on every recorded interaction it would
 * mutate the page mid-run.
 */
function findLabelText(el: Element): string | null {
  const id = el.getAttribute('id');
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    const text = labelTextWithoutControls(label);
    if (text) return text;
  }

  const text = labelTextWithoutControls(el.closest('label'));
  if (text) return text;

  return null;
}

/** Text content of a label with nested form controls removed, from a clone. */
function labelTextWithoutControls(label: Element | null): string | null {
  if (!label) return null;
  const clone = label.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('input, select, textarea').forEach((node) => node.remove());
  const text = (clone.textContent ?? '').trim();
  return text.length > 0 ? text : null;
}

/** Counts stable (non-hash) class names on the element. */
function countStableClasses(el: Element): number {
  return Array.from(el.classList).filter((cls) => isStableClassName(cls)).length;
}

/**
 * Attempts to build a relative-anchor intent if a clear structural relationship exists.
 * Currently detects labeled-by (input inside or next to a label).
 */
function buildRelativeIntent(el: Element): LocatorIntent | null {
  const parent = el.closest('label');
  if (parent) {
    const labelText = (parent.textContent ?? '').trim();
    if (labelText) {
      const anchorRole = getRole(parent);
      return {
        kind: 'relative',
        anchor: { kind: 'role', role: anchorRole ?? 'button', name: labelText, exact: true },
        relation: 'labeled-by',
      };
    }
  }

  return null;
}
