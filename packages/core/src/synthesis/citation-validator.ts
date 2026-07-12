/**
 * Citation-faithfulness validator — the enforcement mechanism for v2's
 * **no-uncited-claims** structural guarantee (plan §6).
 *
 * Runs as a deterministic post-pass over any {@link Brief} and its
 * {@link SynthesisInput}, after *both* synthesis strategies:
 *
 * 1. **Structural** — every inline `[n]` marker in `overview`, section
 *    `body_md`, and finding text resolves to a declared source. (The Brief
 *    schema already refuses dangling `citations[]` arrays; this additionally
 *    scans the free Markdown text those arrays do not cover.)
 * 2. **Anchoring** (LLM path only) — each cited finding's content words are
 *    fuzzy-matched against its cited sources' text. Below-threshold findings
 *    are **flagged** (kept, noticed); numeric findings whose numbers appear
 *    in no cited source are **stripped** (removed, noticed).
 *
 * The verdict `{ claimsChecked, flagged, stripped }` is returned and stamped
 * into `metadata.citation_verdict`; `uncited_claim_*` notices are appended.
 *
 * Deterministic-path Briefs always pass with zero flags — their claims carry
 * their evidence by construction (see `claims.ts`), so anchoring is a no-op
 * and is skipped for that strategy.
 *
 * The enforcement chain is: **schema refinement → this validator → notices**.
 */

import type { Brief, BriefNotice, KeyFinding } from '@yantra/protocol';

import { tokenize } from './similarity.js';
import type { CitationVerdict, SynthesisInput } from './types.js';

/** Inline citation marker, e.g. `[3]`. */
const INLINE_CITATION = /\[(\d+)\]/g;

/** Digit groups used to compare a claim's numbers against source text. */
const NUMBER_GROUP = /\d[\d.,]*/g;

/**
 * Minimum fraction of a finding's content words that must appear in its
 * cited sources for the finding to count as anchored.
 */
const ANCHOR_OVERLAP_THRESHOLD = 0.5;

/** Options controlling {@link validateCitations}. */
export interface ValidateCitationsOptions {
  /** Which strategy produced the Brief; anchoring runs on `llm` only. */
  readonly strategy: 'deterministic' | 'llm';
}

/** Output of {@link validateCitations}. */
export interface CitationValidationResult {
  /** The Brief with `citation_verdict` stamped and notices appended; on the
   * LLM path, stripped findings are removed. */
  readonly brief: Brief;
  /** The faithfulness verdict (also present at `brief.metadata.citation_verdict`). */
  readonly verdict: CitationVerdict;
}

/**
 * Validates citation faithfulness and returns the annotated Brief + verdict.
 *
 * Never throws. On the deterministic path it performs only the structural
 * pass (which the builder already satisfies), so the verdict is
 * `{ claimsChecked: findings, flagged: 0, stripped: 0 }`.
 *
 * @param brief - The synthesized document to check.
 * @param input - The originating synthesis input (source evidence text).
 * @param opts - Strategy selector; anchoring is LLM-only.
 * @returns The annotated Brief and the citation verdict.
 */
export function validateCitations(
  brief: Brief,
  input: SynthesisInput,
  opts: ValidateCitationsOptions,
): CitationValidationResult {
  const declared = new Set(brief.sources.map((source) => source.n));
  const notices: BriefNotice[] = [];
  let claimsChecked = 0;
  let flagged = 0;
  let stripped = 0;

  // --- Structural pass: inline [n] markers beyond the declared source set.
  const structuralFlag = (text: string, where: string): void => {
    for (const match of text.matchAll(INLINE_CITATION)) {
      claimsChecked += 1;
      const n = Number(match[1]);
      if (!declared.has(n)) {
        flagged += 1;
        notices.push({
          source: where,
          reason: `inline citation [${n}] does not resolve to a declared source`,
          kind: 'uncited_claim_flagged',
        });
      }
    }
  };

  structuralFlag(brief.overview, 'overview');
  brief.sections.forEach((section, index) => structuralFlag(section.body_md, `section:${index}`));

  // --- Anchoring pass (LLM path only).
  const textByNumber = buildSourceTextMap(brief, input);
  const keptFindings: KeyFinding[] = [];

  brief.key_findings.forEach((finding) => {
    // Inline markers inside finding text are also structurally checked.
    structuralFlag(finding.text, 'finding');
    (finding.children ?? []).forEach((child) => structuralFlag(child.text, 'finding child'));

    if (opts.strategy !== 'llm' || finding.editorial) {
      keptFindings.push(finding);
      return;
    }

    claimsChecked += 1;
    const citedText = finding.citations
      .map((n) => textByNumber.get(n) ?? '')
      .join('\n')
      .toLowerCase();

    // Strip inline [n] markers so citation numbers aren't mistaken for claim
    // figures during the numeric-mismatch and anchoring checks.
    const claimBody = finding.text.replace(/\[\d+\]/g, ' ');

    const numericMismatch = hasNumericMismatch(claimBody, citedText);
    if (numericMismatch) {
      stripped += 1;
      notices.push({
        source: 'synthesis',
        reason: `numeric claim not supported by its cited source(s): "${truncate(finding.text)}"`,
        kind: 'uncited_claim_stripped',
      });
      return; // drop the finding
    }

    if (!isAnchored(claimBody, citedText)) {
      flagged += 1;
      notices.push({
        source: 'synthesis',
        reason: `claim weakly anchored to its cited source(s): "${truncate(finding.text)}"`,
        kind: 'uncited_claim_flagged',
      });
    }

    keptFindings.push(finding);
  });

  const verdict: CitationVerdict = { claimsChecked, flagged, stripped };

  const annotated: Brief = {
    ...brief,
    key_findings: keptFindings,
    notices: [...brief.notices, ...notices],
    metadata: {
      ...brief.metadata,
      citation_verdict: {
        claims_checked: verdict.claimsChecked,
        flagged: verdict.flagged,
        stripped: verdict.stripped,
      },
    },
  };

  return { brief: annotated, verdict };
}

/** Maps each source number to its evidence text (matched by URL, then host). */
function buildSourceTextMap(brief: Brief, input: SynthesisInput): Map<number, string> {
  const map = new Map<number, string>();
  for (const source of brief.sources) {
    const normalized = source.final_url ?? source.url;
    const matching = input.docs.filter(
      (doc) => (doc.finalUrl ?? doc.url) === normalized || doc.host === source.host,
    );
    map.set(source.n, matching.map((doc) => doc.text).join('\n'));
  }
  return map;
}

/** True when the claim's content words are well-represented in the source text. */
function isAnchored(claimText: string, citedText: string): boolean {
  const claimWords = new Set(tokenize(claimText));
  if (claimWords.size === 0) {
    return true;
  }
  const sourceWords = new Set(tokenize(citedText));
  let hits = 0;
  for (const word of claimWords) {
    if (sourceWords.has(word)) {
      hits += 1;
    }
  }
  return hits / claimWords.size >= ANCHOR_OVERLAP_THRESHOLD;
}

/**
 * True when the claim contains a number that appears in no cited source —
 * the signature of a fabricated statistic. Numbers are compared on their
 * digit groups with thousands separators removed.
 */
function hasNumericMismatch(claimText: string, citedText: string): boolean {
  const claimNumbers = extractNumbers(claimText);
  if (claimNumbers.size === 0) {
    return false;
  }
  const sourceNumbers = extractNumbers(citedText);
  for (const number of claimNumbers) {
    if (!sourceNumbers.has(number)) {
      return true;
    }
  }
  return false;
}

function extractNumbers(text: string): Set<string> {
  const numbers = new Set<string>();
  for (const match of text.matchAll(NUMBER_GROUP)) {
    const normalized = match[0].replace(/[.,]/g, '');
    if (normalized.length > 0) {
      numbers.add(normalized);
    }
  }
  return numbers;
}

function truncate(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
