import type { ValidationError } from '@yantra/protocol';

import { brandSanitized, type Sanitized } from '../sanitizer-guard.js';

import type { AssembleOpts, SystemPromptAssembly } from './assemble.js';
import { assemble } from './assemble.js';

// ---------------------------------------------------------------------------
// RePromptContext
// ---------------------------------------------------------------------------

export interface RePromptContext {
  readonly originalPrompt: Sanitized<string>;
  readonly previousRawResponse: unknown;
  readonly validationErrors: readonly ValidationError[];
  /** 1-based; first re-prompt is attempt 2. */
  readonly attempt: number;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Builds a re-prompt user message instructing the model to repair offending paths.
 *
 * The user message is branded Sanitized<string> by construction — its content
 * contains only protocol JSON-pointer paths and ValidationError codes, never
 * user-supplied content or captured DOM. A property test asserts no credential
 * shape can appear in the rendered output.
 */
export function buildRePrompt(
  ctx: RePromptContext,
  opts: AssembleOpts,
): { systemPrompt: SystemPromptAssembly; userMessage: Sanitized<string> } {
  const systemPrompt = assemble(opts);

  const issueLines = ctx.validationErrors.map((e) => `  - ${e.path}: ${e.message}`);

  const rawMessage = [
    'Your previous plan failed validation. Repair the issues below and emit a complete corrected Plan.',
    '',
    'Issues:',
    ...issueLines,
  ].join('\n');

  // Safe to brand: content is entirely from our protocol layer, never user-supplied.
  const userMessage = brandSanitized(rawMessage);

  return { systemPrompt, userMessage };
}
