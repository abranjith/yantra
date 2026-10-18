import { progressScenario, EXTRACT, risingFills } from '../progress-support.js';

import {
  contractStep,
  FULL_ACTIONS_CONTRACT,
  NAVIGATE_STEP,
  fillAnswersStep,
  publishFormStep,
} from './do-form.js';
export const doProgressStallRecovers = progressScenario(
  'do-progress-stall-recovers',
  [
    contractStep(FULL_ACTIONS_CONTRACT),
    NAVIGATE_STEP,
    EXTRACT,
    EXTRACT,
    { kind: 'advance-clock', ms: 65000 },
    { kind: 'call', tool: 'workflow_run', params: { mode: 'list' } },
    { kind: 'advance-clock', ms: 65000 },
    {
      kind: 'call',
      tool: 'browser_navigate',
      params: { url: 'view-source:https://test-form.yantra.test/apply' },
    },
    {
      kind: 'call',
      tool: 'browser_fill_form',
      when: (ctx) => ctx.steers().length > 0,
      params: (ctx) => {
        const refs = [...ctx.steers()[0]!.matchAll(/(e\d+) \(/gu)].map((m) => m[1]!);
        return refs.length === 0
          ? null
          : { fields: refs.map((field, i) => ({ field, value: `Sample answer ${i + 1}` })) };
      },
    },
    fillAnswersStep(11, 20),
    { kind: 'call', tool: 'browser_capture', params: { scope: 'viewport' } },
    publishFormStep(),
  ],
  ['steer'],
  [risingFills],
);
