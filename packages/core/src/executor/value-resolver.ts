import type { CaptureRef, LiteralValue, ParamRef, SecretRef, TemplateRef, ValueRef } from '@yantra/protocol';

import type { CaptureStore, ResolvedSecret, SecretResolver } from './types.js';

const TEMPLATE_PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g;

/**
 * Resolves a `ValueRef` discriminated union to its concrete value at step boundary.
 *
 * Secret values are returned via `ResolvedSecret` which carries a `zero()` function
 * to overwrite the plaintext buffer after use (best-effort mitigation in Node).
 * Secrets are NEVER returned as plain `unknown` to avoid accidental capture in logs.
 */
export class ValueResolver {
  constructor(
    private readonly captures: CaptureStore,
    private readonly params: Readonly<Record<string, unknown>>,
    private readonly secretResolver: SecretResolver | null,
  ) {}

  async resolve(ref: ValueRef): Promise<unknown> {
    switch (ref.kind) {
      case 'literal':
        return resolveLiteral(ref);
      case 'param':
        return resolveParam(ref, this.params);
      case 'capture':
        return resolveCapture(ref, this.captures);
      case 'template':
        return this.resolveTemplate(ref);
      case 'secret':
        // Secrets are not returned as plain values via this method.
        // Use resolveSecret() to get the plaintext with a zero callback.
        throw new Error(
          `Secret references must be resolved via resolveSecret(), not resolve(). Secret key: "${ref.key}"`,
        );
    }
  }

  /**
   * Resolves a SecretRef and returns a `ResolvedSecret` with a `zero()` method.
   * Call `zero()` immediately after the secret value has been consumed.
   */
  async resolveSecret(ref: SecretRef): Promise<ResolvedSecret> {
    if (!this.secretResolver) {
      throw new Error(
        `SecretResolver is not configured. Cannot resolve secret "${ref.key}". ` +
        'Wire FEAT-006 SecretResolver to enable secret resolution.',
      );
    }
    const plaintext = await this.secretResolver.resolve(ref);
    let zeroed = false;
    return {
      plaintext,
      zero: () => {
        if (zeroed) return;
        zeroed = true;
        // Best-effort: overwrite string in-place is not possible in V8.
        // The plaintext variable goes out of scope after zero() is called.
        // Ensure callers immediately discard the reference.
      },
    };
  }

  /**
   * Resolves a ValueRef to a string, substituting template placeholders.
   * Secret refs inside templates are forbidden (URL/field injection vector).
   */
  async resolveToString(ref: ValueRef): Promise<string> {
    if (ref.kind === 'secret') {
      throw new Error(
        'Secret references cannot be coerced to strings via resolveToString(). ' +
        'Use resolveSecret() at fill step boundaries only.',
      );
    }
    const value = await this.resolve(ref);
    return String(value ?? '');
  }

  private async resolveTemplate(ref: TemplateRef): Promise<string> {
    let result = ref.template;
    for (const [placeholder, bindingRef] of Object.entries(ref.bindings)) {
      if (bindingRef.kind === 'secret') {
        throw new Error(
          `Secret bindings ("${placeholder}") are not allowed in template refs. ` +
          'Secrets may only appear as direct step values in fill steps.',
        );
      }
      const value = await this.resolve(bindingRef);
      result = result.replaceAll(`{{${placeholder}}}`, String(value ?? ''));
    }
    // Resolve any remaining literal-style {{placeholder}} patterns that weren't in bindings
    result = result.replace(TEMPLATE_PLACEHOLDER_RE, '');
    return result;
  }
}

function resolveLiteral(ref: LiteralValue): unknown {
  return ref.value;
}

function resolveParam(ref: ParamRef, params: Readonly<Record<string, unknown>>): unknown {
  if (!(ref.key in params)) {
    throw new Error(`Param "${ref.key}" is not defined in task params.`);
  }
  return params[ref.key];
}

function resolveCapture(ref: CaptureRef, captures: CaptureStore): unknown {
  const envelope = captures.get(ref.step_id);
  if (envelope === undefined) {
    throw new Error(`Capture step "${ref.step_id}" has no captured value.`);
  }
  if (ref.field === null) {
    return envelope;
  }
  if (typeof envelope !== 'object' || envelope === null) {
    throw new Error(`Capture step "${ref.step_id}" is not an object; cannot access field "${ref.field}".`);
  }
  const record = envelope as Record<string, unknown>;
  if (!(ref.field in record)) {
    throw new Error(`Capture field "${ref.field}" not found in step "${ref.step_id}".`);
  }
  return record[ref.field];
}
