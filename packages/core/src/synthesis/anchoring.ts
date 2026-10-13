/** Pure, deterministic evidence anchoring shared by both publication paths. */
import { tokenize } from './similarity.js';

export const ANCHOR_OVERLAP_THRESHOLD = 0.5;
const NUMBER_GROUP = /\d[\d.,]*/gu;
export interface AnchorClaim {
  readonly id: string;
  readonly kind: 'cell' | 'finding' | 'section' | 'constraint';
  readonly text: string;
  readonly refs: readonly string[];
  readonly mode: 'numbers' | 'numbers-and-words';
}
export interface AnchorReport {
  readonly checked: number;
  readonly flagged: readonly {
    readonly id: string;
    readonly kind: AnchorClaim['kind'];
    readonly text: string;
    readonly missing: readonly string[];
  }[];
}
/** Canonical Unicode, case and whitespace representation of evidence. */
export function normalizeEvidence(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}
/** Numeric digit groups with decimal/thousands separators removed. */
export function digitGroups(text: string): Set<string> {
  return new Set(
    [...normalizeEvidence(text).matchAll(NUMBER_GROUP)].map((match) =>
      match[0].replace(/[.,]/gu, ''),
    ),
  );
}
/** True when at least half the claim's content tokens appear in evidence. */
export function isAnchored(claim: string, evidence: string): boolean {
  const words = new Set(tokenize(normalizeEvidence(claim)));
  if (words.size === 0) return true;
  const source = new Set(tokenize(normalizeEvidence(evidence)));
  return (
    [...words].filter((word) => source.has(word)).length / words.size >= ANCHOR_OVERLAP_THRESHOLD
  );
}
/** Claim numbers absent from all cited evidence, in first-appearance order. */
export function numbersMissing(claim: string, evidence: string): string[] {
  const source = digitGroups(evidence);
  return [...digitGroups(claim)].filter((number) => !source.has(number));
}
/** Check cited claims without removing or mutating any of them. */
export function checkAnchoring(
  claims: readonly AnchorClaim[],
  evidenceFor: (ref: string) => string | null,
): AnchorReport {
  const flagged: AnchorReport['flagged'][number][] = [];
  for (const claim of claims) {
    const evidence = claim.refs.map((ref) => evidenceFor(ref) ?? '').join('\n');
    const missing = numbersMissing(claim.text, evidence);
    // Numbers have their own normalized check; grouping punctuation is not a word.
    const words = normalizeEvidence(claim.text).replace(NUMBER_GROUP, ' ');
    if (missing.length > 0 || (claim.mode === 'numbers-and-words' && !isAnchored(words, evidence)))
      flagged.push({ id: claim.id, kind: claim.kind, text: claim.text, missing });
  }
  return { checked: claims.length, flagged };
}
