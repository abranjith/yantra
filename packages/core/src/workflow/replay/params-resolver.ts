/**
 * Resolves CLI params + file params into a typed record.
 *
 * Algorithm:
 * 1. Parse `--params-file` YAML (if provided).
 * 2. Overlay `--params key=value` CLI args (CLI wins on collision).
 * 3. Coerce each value to the declared type (string/number/boolean/date).
 * 4. Validate required params are present.
 * 5. Reject params that look like credentials.
 *
 * @example
 * const params = await resolveParams({
 *   cli: [{ key: 'month', rawValue: '2026-04' }],
 *   workflowParams: { month: { type: 'string', required: true, example: null } },
 * });
 * // => { month: '2026-04' }
 */

import { readFile } from 'node:fs/promises';

import { parse as parseYaml } from 'yaml';

import { MissingRequiredParamError, ParamsValidationError } from './errors.js';
import type { ParamArg, WorkflowParamsSpec } from './types.js';

// Credential-shape patterns — must match those in lint/rules/secret-shaped-literal.ts
const CREDENTIAL_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AKIA[A-Z0-9]{16}/,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
];

function looksLikeCredential(value: string): boolean {
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(value)) return true;
  }
  return false;
}

/**
 * Resolves workflow params from CLI args and optional file, coercing to declared types.
 */
export async function resolveParams(input: {
  cli: readonly ParamArg[];
  file?: string;
  workflowParams: WorkflowParamsSpec;
}): Promise<Record<string, unknown>> {
  const { cli, file, workflowParams } = input;

  // Step 1: Read file params
  let fileParams: Record<string, unknown> = {};
  if (file !== undefined) {
    const raw = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      throw new ParamsValidationError(
        '<file>',
        `Cannot read params file "${file}": ${err.message}`,
      );
    });
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ParamsValidationError('<file>', `Invalid YAML in params file "${file}": ${msg}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ParamsValidationError(
        '<file>',
        `Params file "${file}" must contain a YAML mapping at the top level, not a scalar or array.`,
      );
    }
    fileParams = parsed as Record<string, unknown>;
  }

  // Step 2: Overlay CLI args (CLI wins)
  const merged: Record<string, unknown> = { ...fileParams };
  for (const arg of cli) {
    merged[arg.key] = arg.rawValue;
  }

  // Step 3: Coerce and validate each declared param
  const result: Record<string, unknown> = {};
  for (const [key, decl] of Object.entries(workflowParams)) {
    const rawValue = merged[key];

    if (rawValue === undefined || rawValue === null) {
      // Will be caught in step 4 if required
      continue;
    }

    const strValue = stringifySafe(rawValue);

    // Step 5 (inline): Reject credential-shaped values
    if (looksLikeCredential(strValue)) {
      throw new ParamsValidationError(
        key,
        `The value for param "${key}" looks like a secret or credential. ` +
          `Params are not secrets — declare a \`secrets:\` entry and reference it via {{ secret:namespace.key }} instead.`,
        '<redacted>',
      );
    }

    result[key] = coerceValue(key, strValue, decl.type);
  }

  // Pass-through extra params not declared in the workflow (they won't be used but don't error)
  for (const [key, value] of Object.entries(merged)) {
    if (!(key in workflowParams) && value !== undefined) {
      const strValue = stringifySafe(value);
      if (looksLikeCredential(strValue)) {
        throw new ParamsValidationError(
          key,
          `The value for param "${key}" looks like a secret or credential. ` +
            `Params are not secrets — declare a \`secrets:\` entry and reference it via {{ secret:namespace.key }} instead.`,
          '<redacted>',
        );
      }
      result[key] = strValue;
    }
  }

  // Step 4: Validate required params
  const missing: string[] = [];
  for (const [key, decl] of Object.entries(workflowParams)) {
    if (decl.required && !(key in result)) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new MissingRequiredParamError(missing);
  }

  return result;
}

function stringifySafe(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function coerceValue(
  key: string,
  rawValue: string,
  type: WorkflowParamsSpec[string]['type'],
): unknown {
  switch (type) {
    case 'string':
      return rawValue;

    case 'number': {
      const n = Number(rawValue);
      if (isNaN(n)) {
        throw new ParamsValidationError(
          key,
          `Expected a number but got "${rawValue}". Provide a numeric value (e.g., 42 or 3.14).`,
        );
      }
      return n;
    }

    case 'boolean': {
      if (rawValue === 'true') return true;
      if (rawValue === 'false') return false;
      throw new ParamsValidationError(
        key,
        `Expected a boolean but got "${rawValue}". Use "true" or "false".`,
      );
    }

    case 'date': {
      // Accept ISO-8601 dates and year-month patterns
      const d = new Date(rawValue);
      if (isNaN(d.getTime())) {
        throw new ParamsValidationError(
          key,
          `Expected an ISO-8601 date but got "${rawValue}". Example: "2026-04-01".`,
        );
      }
      return d;
    }

    default: {
      const _exhaustive: never = type;
      throw new ParamsValidationError(key, `Unknown param type "${_exhaustive as string}".`);
    }
  }
}
