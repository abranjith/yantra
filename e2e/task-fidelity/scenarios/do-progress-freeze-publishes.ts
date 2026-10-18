import {
  progressScenario,
  STALL_WINDOW,
  EXTRACT,
  partialAfterFreeze,
} from '../progress-support.js';

import { contractStep, FULL_ACTIONS_CONTRACT, NAVIGATE_STEP, publishFormStep } from './do-form.js';
export const doProgressFreezePublishes = progressScenario(
  'do-progress-freeze-publishes',
  [
    contractStep(FULL_ACTIONS_CONTRACT),
    NAVIGATE_STEP,
    EXTRACT,
    ...STALL_WINDOW,
    ...STALL_WINDOW,
    publishFormStep({
      met: false,
      unmet: [
        { item: 'fill', reason: 'the fields could not be filled' },
        { item: 'artifact:screenshot:viewport', reason: 'not captured' },
      ],
    }),
  ],
  ['steer', 'freeze'],
  [partialAfterFreeze],
);
