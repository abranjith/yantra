/**
 * Maps `"auto"|"none"` workflow cookie mode to a `ProfileSpec`.
 *
 * @example
 * cookieModeToProfileSpec('auto', 'bank-statement')
 * // => { kind: 'workflow', workflowName: 'bank-statement' }
 *
 * @example
 * cookieModeToProfileSpec('none', 'bank-statement')
 * // => { kind: 'ephemeral' }
 */

import type { ProfileSpec } from '../../browser/types.js';

import { WorkflowTranslationError } from './errors.js';

/**
 * Converts a workflow's `cookies` field to the appropriate `ProfileSpec`.
 *
 * - `"auto"` → per-workflow profile dir (persists cookies between runs)
 * - `"none"` → fresh ephemeral profile per run (no persistent cookies)
 *
 * Unknown values (forward-compat) throw `WorkflowTranslationError`.
 */
export function cookieModeToProfileSpec(mode: string, workflowName: string): ProfileSpec {
  if (mode === 'auto') {
    return { kind: 'workflow', workflowName };
  }
  if (mode === 'none') {
    return { kind: 'ephemeral' };
  }
  throw new WorkflowTranslationError(
    'UNKNOWN_COOKIE_MODE',
    `Unknown workflow cookies mode "${mode}". Expected "auto" or "none".`,
  );
}
