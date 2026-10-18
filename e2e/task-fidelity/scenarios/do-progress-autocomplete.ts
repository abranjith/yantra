import { progressScenario, clickObserved } from '../progress-support.js';

import { contractStep, FORM_HOST, publishFormStep } from './do-form.js';
export const doProgressAutocomplete = progressScenario(
  'do-progress-autocomplete',
  [
    contractStep({
      deliverable: 'actions',
      subject: 'autocomplete and verification',
      required_sources: [FORM_HOST],
      fill: { coverage: 'listed', fields: ['Destination'] },
    }),
    {
      kind: 'call',
      tool: 'browser_navigate',
      params: { url: 'https://test-form.yantra.test/progress/autocomplete' },
    },
    {
      kind: 'call',
      tool: 'browser_fill_form',
      params: { fields: [{ field: 'Destination', value: 'North' }] },
    },
    { kind: 'call', tool: 'browser_observe', params: {} },
    clickObserved('Confirm selection'),
    { kind: 'call', tool: 'browser_observe', params: {} },
    publishFormStep(),
  ],
  [],
  [],
  {
    goal: 'Choose North in the Destination autocomplete at https://test-form.yantra.test/progress/autocomplete and confirm the selection.',
  },
);
