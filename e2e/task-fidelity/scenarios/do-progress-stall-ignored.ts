import { progressScenario, STALL_WINDOW, EXTRACT, failedWith } from '../progress-support.js';

import { contractStep, FULL_ACTIONS_CONTRACT, NAVIGATE_STEP } from './do-form.js';
export const doProgressStallIgnored = progressScenario(
  'do-progress-stall-ignored',
  [
    contractStep(FULL_ACTIONS_CONTRACT),
    NAVIGATE_STEP,
    EXTRACT,
    ...STALL_WINDOW,
    ...STALL_WINDOW,
    EXTRACT,
    EXTRACT,
  ],
  ['steer', 'freeze', 'stop'],
  [failedWith('AGENT_STALLED')],
);
