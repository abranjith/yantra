/** Pure, deterministic evidence anchoring shared by both publication paths. */
import { tokenize } from './similarity.js';

export const ANCHOR_OVERLAP_THRESHOLD = 0.5;
const NUMBER_GROUP = /[+-]?(?:\d(?:[\d.,]*\d)?|\.\d+)/gu;
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
/** English-style grouped/decimal values, preserving magnitude and sign.
 * Unsupported separator patterns remain exact tokens rather than guessed values.
 */
export function digitGroups(text: string): Set<string> {
  return normalizedNumbers(normalizeEvidence(text));
}
function normalizedNumbers(text: string): Set<string> {
  return new Set(
    [...text.replace(/([+-])\s*[$€£]\s*(?=[.\d])/gu, '$1').matchAll(NUMBER_GROUP)].map((match) => {
      const raw = match[0];
      if (!/^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?|\.\d+)$/u.test(raw))
        return `ambiguous:${raw}`;
      const [whole = '', fraction = ''] = raw.replaceAll(',', '').replace(/^[+-]/u, '').split('.');
      const integer = whole.replace(/^0+(?=\d)/u, '') || '0';
      const decimals = fraction.replace(/0+$/u, '');
      const sign = raw.startsWith('-') && (integer !== '0' || decimals.length > 0) ? '-' : '';
      return `${sign}${integer}${decimals.length > 0 ? `.${decimals}` : ''}`;
    }),
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
  const prepared = new Map<string, EvidenceTerms>();
  const groups = new Map<string, EvidenceTerms>();
  const termsFor = (refs: readonly string[]): EvidenceTerms => {
    const ids = [...new Set(refs)].sort();
    const key = JSON.stringify(ids);
    const existing = groups.get(key);
    if (existing !== undefined) return existing;
    const words = new Set<string>();
    const numbers = new Set<string>();
    for (const ref of ids) {
      let terms = prepared.get(ref);
      if (terms === undefined) {
        const text = normalizeEvidence(evidenceFor(ref) ?? '');
        terms = { words: new Set(tokenize(text)), numbers: normalizedNumbers(text) };
        prepared.set(ref, terms);
      }
      for (const word of terms.words) words.add(word);
      for (const number of terms.numbers) numbers.add(number);
    }
    const terms = { words, numbers };
    groups.set(key, terms);
    return terms;
  };
  for (const claim of claims) {
    const evidence = termsFor(claim.refs);
    const normalized = normalizeEvidence(claim.text);
    const missing = [...normalizedNumbers(normalized)].filter(
      (number) => !evidence.numbers.has(number),
    );
    // Numbers have their own normalized check; grouping punctuation is not a word.
    const words = new Set(tokenize(normalized.replace(NUMBER_GROUP, ' ')));
    const overlap =
      words.size === 0
        ? 1
        : [...words].filter((word) => evidence.words.has(word)).length / words.size;
    if (
      missing.length > 0 ||
      (claim.mode === 'numbers-and-words' && overlap < ANCHOR_OVERLAP_THRESHOLD)
    )
      flagged.push({ id: claim.id, kind: claim.kind, text: claim.text, missing });
  }
  return { checked: claims.length, flagged };
}

interface EvidenceTerms {
  readonly words: ReadonlySet<string>;
  readonly numbers: ReadonlySet<string>;
}
