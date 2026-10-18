import { progressScenario, STALL_WINDOW, EXTRACT, clickObserved } from '../progress-support.js';

import { contractStep, publishFormStep } from './do-form.js';
export const doProgressClickthrough = progressScenario(
  'do-progress-clickthrough',
  [
    contractStep({ deliverable: 'actions', subject: 'a click-through' }),
    {
      kind: 'call',
      tool: 'browser_navigate',
      params: { url: 'https://test-form.yantra.test/progress/start' },
    },
    { kind: 'call', tool: 'browser_observe', params: {} },
    clickObserved('Continue'),
    EXTRACT,
    ...STALL_WINDOW,
    publishFormStep(),
  ],
  ['steer'],
  [],
  {
    goal: 'Follow Continue from https://test-form.yantra.test/progress/start and report the result.',
  },
);
