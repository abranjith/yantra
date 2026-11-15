/**
 * What a finished run can do next (FEAT-067): the command it was started
 * with, and what it may have changed on websites. Resumability lives with
 * the replay engine (`workflow/replay/resumability.ts`).
 */

export {
  recoverPriorInvocation,
  settingFlag,
  type PriorInvocation,
  type PriorSource,
} from './prior-invocation.js';
export {
  assessPriorEffects,
  type PriorEffects,
  type PriorEffectsAssessment,
} from './prior-effects.js';
