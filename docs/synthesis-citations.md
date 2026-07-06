# No Uncited Claims — Citation-Faithfulness Enforcement

Yantra v2's Brief carries a structural guarantee: **every assertion maps to a
provided source**. This is the anti-hallucination contract that makes a Brief
trustworthy. It is enforced by a three-link chain, each link a distinct
mechanism (defense in depth), so a defect in one is caught by the next.

## The enforcement chain

### 1. Schema refinement (`packages/protocol/src/schemas/brief.ts`)

The `Brief` Zod schema refuses structurally broken citations at the
trust boundary:

- Every entry in any `citations[]` array must resolve to a declared
  `sources[].n`.
- `sources[].n` is contiguous from 1 with no duplicate normalized URLs.
- A key finding with an empty `citations[]` is legal **only** when
  `editorial: true` — the single sanctioned form of uncited commentary.
- No raw ANSI escape bytes may appear in any document text.

`validateBrief()` returns a `Result` (never throws) with actionable issue
paths, which the LLM synthesis path feeds into its bounded re-prompt loop.

### 2. Citation-faithfulness validator (`packages/core/src/synthesis/citation-validator.ts`)

`validateCitations(brief, input, { strategy })` is the deterministic
post-synthesis pass that catches what the schema cannot see — free-text
Markdown and semantic (rather than structural) fabrication:

- **Structural** — scans inline `[n]` markers in `overview`, section
  `body_md`, and finding text. A marker beyond the declared source set is
  **flagged**, even though the `citations[]` arrays validate.
- **Anchoring (LLM path only)** — fuzzy-matches each cited finding's content
  words against its cited sources' text. Below-threshold findings are
  **flagged** (kept, noticed). A finding whose numbers appear in **no** cited
  source (a fabricated statistic) is **stripped** (removed, noticed).

The deterministic strategy skips anchoring: its claims carry their evidence
by construction (each claim keeps the `docIndexes` it was extracted from), so
its Briefs always pass with zero flags. This invariant is covered by a
500-run property test.

### 3. Notices + verdict

The validator's output is honest and auditable:

- It appends `uncited_claim_flagged` / `uncited_claim_stripped` **notices** to
  the Brief so nothing is silently dropped.
- It stamps `metadata.citation_verdict = { claims_checked, flagged, stripped }`
  and returns the same verdict on the `SynthesisOutcome`.

Both synthesizers run this pass as their final step, so the guarantee holds
regardless of strategy, and `yantra audit` can narrate the verdict.

## Why three links

The schema alone cannot inspect free Markdown prose; the validator alone
cannot guarantee the arrays are well-formed at the type boundary; notices
alone are just reporting. Together they make the chain **refuse → detect →
disclose** — a claim that slips one link is caught by the next, and anything
that survives is surfaced to the user rather than hidden.
