import { z } from 'zod';

/**
 * @example
 * SecurityClass.parse('public')
 */
export const SecurityClass = z
  .enum(['public', 'read-only-data', 'authenticated'])
  .describe('Top-level security class used by tasks and workflows.');

export type SecurityClass = z.infer<typeof SecurityClass>;

/**
 * @example
 * SecurityScope.parse('read-only-data')
 */
export const SecurityScope = SecurityClass.describe('Step-level security scope.');

export type SecurityScope = z.infer<typeof SecurityScope>;

/**
 * @example
 * FailureClass.parse('validation_error')
 */
export const FailureClass = z
  .enum([
    'locator_not_found',
    'navigation_timeout',
    'rate_limited',
    'captcha_detected',
    'mfa_required',
    'network_error',
    'scope_violation',
    'validation_error',
    'ethics_refused',
    'budget_exhausted',
    'user_aborted',
    'unexpected',
    'resume_drift',
    'locator_miss_in_unrecorded_frame',
  ])
  .describe('Failure category emitted in task_failed and retry events.');

export type FailureClass = z.infer<typeof FailureClass>;

export const STEP_VERBS = [
  'navigate',
  'click',
  'fill',
  'extract',
  'wait_for',
  'assert',
  'branch',
  'loop',
  'call_workflow',
  'llm_summarize',
] as const;

export type StepVerb = (typeof STEP_VERBS)[number];

export const ALLOWED_VERBS_BY_SCOPE = {
  public: STEP_VERBS,
  authenticated: STEP_VERBS,
  'read-only-data': ['extract', 'wait_for', 'llm_summarize'],
} as const;
