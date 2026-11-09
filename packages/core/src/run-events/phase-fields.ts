/**
 * Field builders for the deterministic `ask`/`research` phase events
 * (FEAT-063). Every value they return is bounded and safe to persist: a query
 * passes through the run-input redactor, a URL keeps only its origin and path,
 * and no control character survives.
 */

import { PHASE_QUERY_MAX, PHASE_URL_MAX, type RunEventOf } from '@yantra/protocol';

import type { ProcessedSource } from '../extraction/source-processor.js';
import type { BudgetSnapshot, ResearchBudget } from '../research/types.js';
import { redactRunInput } from '../sanitizer/index.js';
import { UserInputMarkerError } from '../sanitizer/user-input-markers.js';
import { defangAttrValue } from '../workflow/recorder/redactor.js';

// C0/C1 control characters and DEL.
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/gu;

/**
 * Replaces control characters with spaces and collapses whitespace, the same
 * way the terminal echo lines do.
 */
export function stripControl(text: string): string {
  return text.replace(CONTROL_CHARS_RE, ' ').replace(/\s+/gu, ' ').trim();
}

/** Cuts `text` to `max` characters (UTF-16 units), ending a cut value with `…`. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  // Never leave half of a surrogate pair at the cut.
  if (/[\uD800-\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * A search query as a phase event may record it: credential-shaped and marked
 * values replaced by their placeholders (`redactRunInput`), control characters
 * stripped, and at most 200 characters.
 */
export function boundedQuery(query: string): string {
  let redacted: string;
  try {
    redacted = redactRunInput({ goal: query }).goal;
  } catch (error) {
    // An unclosed `@{…}` marker may hold a secret: never record it raw.
    if (error instanceof UserInputMarkerError) return '[not shown]';
    throw error;
  }
  return capText(stripControl(redacted), PHASE_QUERY_MAX);
}

/**
 * A URL as a phase event may record it: origin plus path only. Userinfo,
 * query and fragment are dropped; a path that looks like it carries a
 * credential becomes `<origin>/[redacted]`; the result is at most 300
 * characters. Anything that does not parse as an http(s) URL is
 * `[invalid url]`.
 */
export function displayUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '[invalid url]';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '[invalid url]';
  const origin = parsed.origin;
  const path = parsed.pathname;
  if (credentialShaped(path)) return capText(`${origin}/[redacted]`, PHASE_URL_MAX);
  return capText(stripControl(`${origin}${path}`), PHASE_URL_MAX);
}

function credentialShaped(path: string): boolean {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape is checked as written.
  }
  return defangAttrValue(path) === '<defanged>' || defangAttrValue(decoded) === '<defanged>';
}

/** One `budget_snapshot` dimension. */
export type BudgetSnapshotDimension = RunEventOf<'budget_snapshot'>['dimensions'][number];

/** The research budget as `budget_snapshot` dimensions: hops, sources, LLM calls, elapsed. */
export function budgetDimensions(
  snapshot: BudgetSnapshot,
  budget: ResearchBudget,
): BudgetSnapshotDimension[] {
  return [
    { name: 'hops', used: snapshot.hopsUsed, limit: budget.maxHops, unit: 'count' },
    { name: 'sources', used: snapshot.sourcesUsed, limit: budget.maxSources, unit: 'count' },
    { name: 'llm_calls', used: snapshot.llmCallsUsed, limit: budget.maxLlmCalls, unit: 'count' },
    { name: 'elapsed', used: snapshot.elapsedMs, limit: budget.maxWallClockMs, unit: 'ms' },
  ];
}

/** A provider or failure name as a snake_case token of at most `max` characters. */
export function asToken(value: string, max = 48): string {
  const token = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, '_')
    .replace(/^[^a-z]+/u, '')
    .slice(0, max);
  return token.length > 0 ? token : 'unknown';
}

/**
 * The `source_fetched` event for one attempted source: `ok` with a document,
 * `blocked` for an ethics or challenge refusal, `skipped` for the run's own
 * budget or URL-policy refusal, else `failed` (fetch or extract).
 */
export function sourceFetchedEvent(
  url: string,
  processed: ProcessedSource | null,
  meta: {
    readonly hopIndex: number | null;
    readonly sourceIndex: number;
    readonly durationMs: number | null;
    readonly at: string;
  },
): RunEventOf<'source_fetched'> {
  const stage = processed?.failure?.stage ?? null;
  const status =
    processed !== null && processed.doc !== null
      ? 'ok'
      : stage === 'blocked'
        ? 'blocked'
        : stage === 'budget' || stage === 'policy'
          ? 'skipped'
          : 'failed';
  return {
    kind: 'source_fetched',
    hop_index: meta.hopIndex,
    source_index: meta.sourceIndex,
    url: displayUrl(url),
    status,
    failure_class: status === 'ok' ? null : asToken(stage ?? 'unexpected'),
    duration_ms: meta.durationMs,
    at: meta.at,
  };
}
