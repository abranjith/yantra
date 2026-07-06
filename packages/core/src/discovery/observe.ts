/**
 * Discovery observation builder (FEAT-020 TASK-003).
 *
 * After each executed cycle, `buildObservation()` is the **only** place that
 * turns live page state into what the model is allowed to see: current
 * URL/title, a sanitized+truncated Readability digest of the visible text,
 * and a capped, ranked list of interactable elements. The digest passes
 * through the single `sanitize()` chokepoint (public profile) before
 * anything is returned, and the result carries the `Sanitized<T>` brand —
 * this is the only type the discovery driver loop may hand to the agent-side
 * proposer.
 *
 * `mapRunOutcomeToStepOutcome()` translates the executor's `RunOutcome` into
 * the protocol's narrower `DiscoveryStepOutcome` enum. The schema has no
 * generic "handoff" bucket — and since discovery force-confirms every
 * mutating step (TASK-001's `normalizeProposal`), any executor `'handoff'`
 * result in this context IS a denied/timed-out confirmation, so it maps to
 * `'confirmation_denied'`.
 */

import type { DiscoveryObservation, DiscoveryStepOutcome } from '@yantra/protocol';
import { DiscoveryObservation as DiscoveryObservationSchema } from '@yantra/protocol';

import type { Page } from '../browser/types.js';
import type { Extractor } from '../extraction/readability.js';
import type { FetchedDoc } from '../extraction/types.js';
import { brandSanitized, type Sanitized } from '../sanitizer/brand.js';
import { sanitize } from '../sanitizer/index.js';

import { scanInteractablesInPage } from './interactable-scan.js';
import { rankInteractables } from './interactables.js';

/** Max page-digest length in characters — must match protocol's cap. */
export const MAX_PAGE_DIGEST_LEN = 8_000;

/** The already-classified outcome of the cycle's step execution. */
export interface CycleExecutionSummary {
  readonly outcome: DiscoveryStepOutcome;
  readonly reason: string | null;
}

/** Dependencies for {@link buildObservation}. */
export interface BuildObservationDeps {
  readonly extractor: Extractor;
}

/**
 * Builds a sanitized, protocol-valid observation of the current page.
 *
 * Best-effort throughout: a failed title/HTML read, a failed extraction, or a
 * failed interactable scan degrades to an empty/null value rather than
 * throwing — an observation must never make a discovery cycle fail outright,
 * since the model can react to a sparse observation just as it would to a
 * blocked page.
 *
 * @param page - The live page after the cycle's steps executed.
 * @param cycleResult - The classified step outcome for this cycle.
 * @param deps - The Readability extractor.
 */
export async function buildObservation(
  page: Page,
  cycleResult: CycleExecutionSummary,
  deps: BuildObservationDeps,
): Promise<Sanitized<DiscoveryObservation>> {
  const url = page.url();
  const host = safeHost(url);

  const pageData = await safeEvaluate(page, () => ({
    title: document.title,
    html: document.documentElement.outerHTML,
  }));

  const digestText = await buildDigest(url, pageData?.html ?? '', deps.extractor);
  const sanitizedDigest = sanitize(digestText, 'public', host ?? undefined);
  const pageDigest = clampChars(sanitizedDigest.text, MAX_PAGE_DIGEST_LEN);

  const rawInteractables = (await safeEvaluate(page, scanInteractablesInPage)) ?? [];
  const interactables = rankInteractables(rawInteractables);

  const observation: DiscoveryObservation = {
    url,
    title:
      pageData?.title !== undefined && pageData.title.length > 0
        ? clampChars(pageData.title, 300)
        : null,
    page_digest: pageDigest,
    interactables,
    step_outcome: cycleResult.outcome,
    outcome_reason: cycleResult.reason !== null ? clampChars(cycleResult.reason, 500) : null,
  };

  // Self-check: catch a builder bug (e.g. a cap miscount) as a loud runtime
  // error rather than silently shipping a schema-invalid observation.
  DiscoveryObservationSchema.parse(observation);

  return brandSanitized(observation);
}

/**
 * Maps the executor's `RunOutcome`-shaped result into the protocol's
 * `DiscoveryStepOutcome`. See module doc for the handoff→confirmation_denied
 * rationale.
 */
export function mapRunOutcomeToStepOutcome(outcome: {
  readonly status: 'completed' | 'failed' | 'handoff';
  readonly failureClass?: string;
}): CycleExecutionSummary {
  if (outcome.status === 'completed') {
    return { outcome: 'completed', reason: null };
  }
  if (outcome.status === 'handoff') {
    return {
      outcome: 'confirmation_denied',
      reason: 'The requested action was not confirmed by the user.',
    };
  }
  if (outcome.failureClass === 'ethics_refused') {
    return {
      outcome: 'ethics_refused',
      reason: 'Blocked by the ethics gate (robots.txt, blocklist, or rate limit).',
    };
  }
  return { outcome: 'failed', reason: `Step failed: ${outcome.failureClass ?? 'unexpected'}` };
}

async function buildDigest(url: string, html: string, extractor: Extractor): Promise<string> {
  if (html.length === 0) {
    return '';
  }
  const doc: FetchedDoc = {
    url,
    finalUrl: url,
    fetchedAt: new Date().toISOString(),
    contentType: 'text/html',
    html,
    statusCode: 200,
    fetchMode: 'browser',
    elapsedMs: 0,
  };
  try {
    const article = await extractor.extract(doc);
    return article?.contentText ?? '';
  } catch {
    return '';
  }
}

/** Runs `page.evaluate(fn)`, degrading to null on any failure (best-effort). */
async function safeEvaluate<T>(page: Page, fn: () => T): Promise<T | null> {
  try {
    return await page.evaluate(fn);
  } catch {
    return null;
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Clamps a string to `max` UTF-16 code units (matches the Zod `.max()` semantics). */
function clampChars(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}
