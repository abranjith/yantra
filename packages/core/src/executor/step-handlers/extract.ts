import type {
  ExtractionResultEnvelopeUnknown,
  ExtractionSchema,
  ExtractStep,
} from '@yantra/protocol';

import { ExecutorLocatorNotFoundError } from '../errors.js';
import type { StepHandler, StepResult } from '../types.js';

import { resolveLocatorChain } from './locator-helpers.js';

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

  const chainResult = await resolveLocatorChain(step.locator, step.id, ctx);
  if (chainResult.kind === 'not_found') {
    const locErr = new ExecutorLocatorNotFoundError(
      { chainName: chainResult.chainName, candidatesCount: chainResult.candidatesCount },
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
    const evaluated = await elementHandle.evaluate(extractFromDom, step.extraction_schema);
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
