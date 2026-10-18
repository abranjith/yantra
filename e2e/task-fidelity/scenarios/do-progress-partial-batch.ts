import { progressScenario, risingFills } from '../progress-support.js';

import {
  contractStep,
  FULL_ACTIONS_CONTRACT,
  NAVIGATE_STEP,
  fillAnswersStep,
  publishFormStep,
} from './do-form.js';
export const doProgressPartialBatch = progressScenario(
  'do-progress-partial-batch',
  [
    contractStep(FULL_ACTIONS_CONTRACT),
    NAVIGATE_STEP,
    {
      kind: 'call',
      tool: 'browser_fill_form',
      params: {
        fields: [
          ...Array.from({ length: 9 }, (_, i) => ({ field: `Answer ${i + 1}`, value: 'Sample' })),
          { field: 'Absent control', value: 'Sample' },
        ],
      },
    },
    fillAnswersStep(10, 19),
    publishFormStep(),
  ],
  [],
  [risingFills],
);
