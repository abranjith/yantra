import { SanitizerGuardError } from './errors.js';

// ---------------------------------------------------------------------------
// Sanitized<T> — compile-time brand
// ---------------------------------------------------------------------------

declare const SanitizedBrand: unique symbol;

/**
 * Nominal brand proving a value flowed through sanitize() before reaching the
 * LLMClient boundary. Raw strings are a TypeScript compile error at call sites.
 */
export type Sanitized<T> = T & { readonly [SanitizedBrand]: true };

// ---------------------------------------------------------------------------
// Runtime registry — belt-and-suspenders guard
// ---------------------------------------------------------------------------

/**
 * Registered sanitized strings (bounded LRU to avoid unbounded memory growth).
 * Only primitive strings are tracked here; objects use the WeakSet below.
 */
const MAX_REGISTRY_SIZE = 10_000;
const sanitizedStrings = new Map<string, true>();

/** Sanitized object references tracked by identity. */
const sanitizedObjects = new WeakSet<object>();

function registerString(value: string): void {
  if (sanitizedStrings.size >= MAX_REGISTRY_SIZE) {
    // Evict oldest entry (Map preserves insertion order)
    const firstKey = sanitizedStrings.keys().next().value;
    if (firstKey !== undefined) {
      sanitizedStrings.delete(firstKey);
    }
  }
  sanitizedStrings.set(value, true);
}

// ---------------------------------------------------------------------------
// brandSanitized — ONLY callable from sanitizer or reprompt builder
// ---------------------------------------------------------------------------

/**
 * Brands a value as Sanitized<T>. Do not call outside packages/core/src/sanitizer
 * or packages/agent/src/prompts/reprompt.ts. The ESLint import-pattern rule and
 * CI grep enforce this.
 *
 * @internal
 */
export function brandSanitized<T>(value: T): Sanitized<T> {
  if (typeof value === 'string') {
    registerString(value);
  } else if (typeof value === 'object' && value !== null) {
    sanitizedObjects.add(value);
  }
  return value as Sanitized<T>;
}

// ---------------------------------------------------------------------------
// assertSanitized — runtime defense-in-depth
// ---------------------------------------------------------------------------

/**
 * Throws SanitizerGuardError if value was not produced by brandSanitized().
 * Called at LLMClient method entry as defense-in-depth against type erasure.
 */
export function assertSanitized(value: unknown): asserts value is Sanitized<unknown> {
  if (typeof value === 'string') {
    if (!sanitizedStrings.has(value)) {
      throw new SanitizerGuardError(
        'Value reaching LLMClient was not registered by sanitize(). ' +
          'Ensure all LLM-bound strings flow through the sanitizer chokepoint.',
      );
    }
    return;
  }

  if (typeof value === 'object' && value !== null) {
    if (!sanitizedObjects.has(value)) {
      throw new SanitizerGuardError(
        'Object reaching LLMClient was not registered by sanitize(). ' +
          'Ensure all LLM-bound objects flow through the sanitizer chokepoint.',
      );
    }
    return;
  }

  throw new SanitizerGuardError(
    `Unexpected value type "${typeof value}" at LLMClient boundary. ` +
      'Expected a sanitized string or object.',
  );
}
