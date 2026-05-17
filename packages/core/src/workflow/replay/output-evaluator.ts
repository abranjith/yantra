/**
 * Evaluates workflow output bindings (JSONata expressions) against run captures.
 *
 * - Non-fatal: eval errors are recorded in `EvaluatedOutputs.errors` and do not
 *   throw. The run does NOT fail because of an output-eval error.
 * - Retention filter: only `persisted` bindings go to `outputs.json`.
 * - Secret-shape redaction: applied to on-disk values (see `redactOutputsForDisk`).
 * - 200 ms timeout and 100 KB result cap per expression (same as FEAT-005 sandbox).
 */

import jsonata from 'jsonata';

import type { EvaluatedOutputs, OutputBinding } from './types.js';

const EVAL_TIMEOUT_MS = 200;
const MAX_RESULT_BYTES = 102_400;

// Credential-shape patterns — match the lint rule set
const CREDENTIAL_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AKIA[A-Z0-9]{16}/,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
];

function containsCredentialShape(s: string): boolean {
  for (const p of CREDENTIAL_PATTERNS) {
    if (p.test(s)) return true;
  }
  return false;
}

function isHighEntropy(s: string): boolean {
  if (s.length < 24) return false;
  const unique = new Set(s).size;
  const hasUpper = /[A-Z]/.test(s);
  const hasLower = /[a-z]/.test(s);
  const hasDigit = /[0-9]/.test(s);
  const score = (hasUpper ? 1 : 0) + (hasLower ? 1 : 0) + (hasDigit ? 1 : 0);
  return unique >= 12 && score >= 3;
}

function redactString(s: string): string {
  if (containsCredentialShape(s) || isHighEntropy(s)) return '<redacted:secret-shape>';
  return s;
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Applies the secret-shape redactor to all string values in `persisted`.
 *
 * The pre-redaction values are untouched in memory (available for `llm_summarize`).
 */
export function redactOutputsForDisk(persisted: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(persisted)) {
    result[k] = redactValue(v);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Expression evaluation
// ---------------------------------------------------------------------------

async function evalExpression(
  expression: string,
  scope: Record<string, unknown>,
): Promise<{ value: unknown } | { error: string }> {
  let compiled: ReturnType<typeof jsonata>;
  try {
    compiled = jsonata(expression);
  } catch (e) {
    return { error: `Invalid JSONata expression: ${e instanceof Error ? e.message : String(e)}` };
  }

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Expression timed out after ${EVAL_TIMEOUT_MS}ms`)),
      EVAL_TIMEOUT_MS,
    ),
  );

  let result: unknown;
  try {
    result = await Promise.race([compiled.evaluate(scope), timeoutPromise]);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const serialized = JSON.stringify(result);
  if (serialized !== undefined) {
    const byteSize = new TextEncoder().encode(serialized).length;
    if (byteSize > MAX_RESULT_BYTES) {
      return {
        error: `Result size (${byteSize} bytes) exceeds the ${MAX_RESULT_BYTES}-byte cap.`,
      };
    }
  }

  return { value: result };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluates all output bindings against the accumulated captures and params.
 *
 * Eval errors are non-fatal: they are recorded in `errors` and the binding
 * receives `undefined` (omitted from `persisted`/`transient`).
 *
 * @example
 * const out = await evaluateOutputs(bindings, { captures: ctx.captures, params: ctx.params });
 * writeOutputs(runDir, { outputs: out.persisted, ... });
 */
export async function evaluateOutputs(
  bindings: readonly OutputBinding[],
  context: {
    captures: Readonly<Record<string, unknown>>;
    params: Readonly<Record<string, unknown>>;
  },
): Promise<EvaluatedOutputs> {
  const persisted: Record<string, unknown> = {};
  const transient: Record<string, unknown> = {};
  const errors: { name: string; error: string }[] = [];

  const scope = {
    capture: context.captures,
    param: context.params,
  };

  await Promise.all(
    bindings.map(async (binding) => {
      const result = await evalExpression(binding.expression, scope);
      if ('error' in result) {
        errors.push({ name: binding.name, error: result.error });
        return;
      }
      if (result.value === undefined) return;

      if (binding.retention === 'persisted') {
        persisted[binding.name] = result.value;
      } else {
        transient[binding.name] = result.value;
      }
    }),
  );

  return { persisted, transient, errors };
}
