import { progressScenario, RESEARCH_STALL_WINDOW } from '../progress-support.js';

import { contractStep, NAVIGATE_STEP, publishFormStep } from './do-form.js';
export const researchProgressObserve = progressScenario(
  'research-progress-observe',
  [
    contractStep({ deliverable: 'report', subject: 'the form inventory' }),
    NAVIGATE_STEP,
    ...RESEARCH_STALL_WINDOW,
    publishFormStep(),
  ],
  [],
  [],
  {
    command: 'research',
    goal: 'Describe the fields at https://test-form.yantra.test/apply.',
    contract: { deliverable: 'report', requiredFields: [], filters: [], requiredSources: [] },
  },
);
