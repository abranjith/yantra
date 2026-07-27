import type {
  ExtractionResultEnvelopeUnknown,
  ExtractionSchema,
  ExtractStep,
} from '@yantra/protocol';
import type { ElementHandle } from 'puppeteer-core';

import { ReadabilityExtractor } from '../../extraction/readability.js';
import { ExecutorLocatorNotFoundError } from '../errors.js';
import type { ExecutionContext, StepHandler, StepResult } from '../types.js';

import { resolveLocatorChain } from './locator-helpers.js';
import { settleBeforeRead } from './settle-helpers.js';

export type ExtractionRow = Record<string, unknown>;
export interface ExtractionErrorRow {
  __error: string;
  __raw: unknown;
}

/**
 * Extract step handler.
 *
 * Resolves the locator, runs basic DOM extraction for the declared schema,
 * builds an `ExtractionResultEnvelope` with per-row error evidence, and stores
 * the result in `CaptureStore`.
 *
 * Hard extract failure (locator resolved, DOM extraction threw) → `failed`.
 * Empty extraction → not a failure (use an AssertStep to enforce non-empty).
 */
export const handleExtract: StepHandler<ExtractStep> = async (step, ctx): Promise<StepResult> => {
  if (!ctx.locatorHost || !ctx.page) {
    return {
      kind: 'failed',
      failureClass: 'unexpected',
      error: new Error('Extract step requires a browser session with an InjectedScriptHost.'),
    };
  }

  // Hold until the page has finished loading and its fetch-driven content has
  // landed. An extract is usually the step right after the click that produces
  // the result, and on a real site that result arrives seconds later.
  await settleBeforeRead(ctx);

  // Extraction reads the element; it never points at it. Demanding the full
  // actionable contract would require the element's centre to be inside the
  // viewport and to win a hit test — which a page-length container such as the
  // `body` locator that `do --save-as` records for an extract step can never
  // do, so every such step timed out as "locator not found".
  const chainResult = await resolveLocatorChain(step.locator, step.id, ctx, {
    requirement: 'visible',
  });
  if (chainResult.kind === 'not_found') {
    const locErr = new ExecutorLocatorNotFoundError(
      {
        chainName: chainResult.chainName,
        candidatesCount: chainResult.candidatesCount,
        diagnostics: chainResult.diagnostics,
      },
      { taskId: ctx.taskId, runId: ctx.runId, stepId: step.id },
    );
    if (ctx.budgets.canRetry('step')) {
      return { kind: 'retried', attempt: 1, reason: 'Locator chain exhausted during extraction' };
    }
    return { kind: 'failed', failureClass: 'locator_not_found', error: locErr };
  }
  if (chainResult.kind === 'error') {
    return { kind: 'failed', failureClass: 'unexpected', error: chainResult.error };
  }

  const { elementHandle } = chainResult;

  let rawData: unknown;
  try {
    const evaluated = isReadable(step.extraction_schema)
      ? await extractReadable(elementHandle, ctx)
      : await elementHandle.evaluate(extractFromDom, step.extraction_schema);
    rawData = toUnknown(evaluated);
  } catch (err) {
    return {
      kind: 'failed',
      failureClass: 'unexpected',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  const { envelope, captureKey } = buildEnvelope(rawData, step.extraction_schema, step.capture_as);

  ctx.captures.set(captureKey, envelope);

  return {
    kind: 'completed',
    captureKeys: [captureKey],
  };
};

// ---------------------------------------------------------------------------
// Readable extraction (Node-side, via the shared Readability pipeline)
// ---------------------------------------------------------------------------

/** True for the `primitive/readable` schema, which bypasses DOM extraction. */
function isReadable(schema: ExtractionSchema): boolean {
  return schema.type === 'primitive' && schema.kind === 'readable';
}

const readabilityExtractor = new ReadabilityExtractor();

/**
 * Extracts the element's article-like content with boilerplate stripped.
 *
 * Runs the same `ReadabilityExtractor` the agent uses to build its own page
 * digest, so a replayed workflow captures what the agent read rather than what
 * `textContent` happens to concatenate — which on a page-level locator means
 * nav, cookie banners, footers, and the text inside `<script>`/`<style>`.
 *
 * Falls back to the element's rendered text when Readability finds no article.
 * That is not an edge case: Readability targets prose documents, and the pages
 * workflows are recorded against — a tracking result, an order summary, an app
 * shell — frequently have none. Returning empty there would make the terminal
 * extract step useless on exactly the sites it exists for. `innerText` is used
 * for the fallback rather than `textContent` because it reflects rendering:
 * hidden elements and script bodies are excluded, and block boundaries survive
 * as newlines.
 */
async function extractReadable(
  elementHandle: ElementHandle,
  ctx: ExecutionContext,
): Promise<string> {
  const { html, text } = await elementHandle.evaluate((el) => ({
    html: (el as unknown as { outerHTML: string }).outerHTML,
    text: (el as unknown as { innerText?: string; textContent: string | null }).innerText ?? '',
  }));

  const url = ctx.page?.url() ?? 'about:blank';
  const article = await readabilityExtractor.extract({
    url,
    finalUrl: url,
    fetchedAt: new Date(ctx.clock.now()).toISOString(),
    contentType: 'text/html',
    html,
    statusCode: 200,
    fetchMode: 'browser',
    elapsedMs: 0,
  });

  const readable = article?.contentText.trim() ?? '';
  return readable.length > 0 ? readable : normalizeVisibleText(text);
}

/**
 * Collapses the runs of blank lines `innerText` leaves between blocks, and the
 * non-breaking spaces real pages are full of, without losing the line breaks
 * that carry the layout's meaning.
 */
function normalizeVisibleText(text: string): string {
  return text
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// DOM extraction (runs in page context via elementHandle.evaluate)
// ---------------------------------------------------------------------------

// Minimal DOM surface needed by extractFromDom — avoids requiring lib: ["DOM"]
// in the build tsconfig. These methods exist on Element at runtime in the browser.
interface DomEl {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<DomEl>;
  querySelector(selector: string): DomEl | null;
}

// This function is serialized and executed in the browser page context via
// `elementHandle.evaluate`, so it must be fully self-contained: every helper it
// calls has to be nested here (a module-level helper is `undefined` in the page,
// which previously failed real extractions with "extractPrimitive is not
// defined"). Recursive self-reference by name is safe — a named function
// expression can reference itself inside its own body.
function extractFromDom(el: DomEl, schema: ExtractionSchema): unknown {
  function extractPrimitive(target: DomEl, kind: string): unknown {
    const text = target.textContent?.trim() ?? '';
    if (kind === 'number') return parseFloat(text.replace(/[^0-9.-]/g, ''));
    if (kind === 'boolean') return text.toLowerCase() === 'true' || text === '1';
    if (kind === 'date') return text;
    if (kind === 'money') return text;
    return text; // string
  }

  if (schema.type === 'primitive') {
    return extractPrimitive(el, schema.kind);
  }
  if (schema.type === 'array') {
    const rows: unknown[] = [];
    Array.from(el.querySelectorAll('tr, li, [data-row]')).forEach((child) => {
      rows.push(extractFromDom(child, schema.items));
    });
    return rows;
  }
  if (schema.type === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [key, fieldSchema] of Object.entries(schema.fields)) {
      const fieldEl = el.querySelector(
        `[data-field="${key}"], td:nth-child(${Object.keys(schema.fields).indexOf(key) + 1}), [class*="${key}"]`,
      );
      obj[key] = fieldEl ? extractFromDom(fieldEl, fieldSchema) : null;
    }
    return obj;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Envelope builder
// ---------------------------------------------------------------------------

function buildEnvelope(
  raw: unknown,
  schema: ExtractionSchema,
  captureKey: string,
): { envelope: ExtractionResultEnvelopeUnknown; captureKey: string } {
  const rows: unknown[] = [];

  if (schema.type === 'array') {
    const arr: unknown[] = Array.isArray(raw) ? raw : [raw];
    for (const item of arr) {
      if (item === null || item === undefined) {
        rows.push({ __error: 'Null or undefined row', __raw: item });
      } else {
        rows.push(item);
      }
    }
  } else {
    rows.push(raw ?? null);
  }

  const validRows = rows.filter(
    (r) => typeof r !== 'object' || r === null || !('__error' in (r as Record<string, unknown>)),
  );
  const errorCount = rows.length - validRows.length;

  const envelope: ExtractionResultEnvelopeUnknown = {
    rows,
    metadata: {
      total_rows: rows.length,
      valid_rows: validRows.length,
      error_count: errorCount,
    },
  };

  return { envelope, captureKey };
}

function toUnknown(value: unknown): unknown {
  return value;
}
