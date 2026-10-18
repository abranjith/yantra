import { progressScenario, failedWith } from '../progress-support.js';

import { contractStep } from './do-form.js';
export const doTurnLimitStops = progressScenario(
  'do-turn-limit-stops',
  [
    contractStep({ deliverable: 'report', subject: 'a thinking limit test' }),
    { kind: 'think', ms: 12000 },
    { kind: 'think', ms: 12000 },
    { kind: 'think', ms: 12000 },
  ],
  ['steer', 'freeze', 'stop'],
  [failedWith('AGENT_TURN_TIMEOUT')],
  {
    budgets: { turnTimeoutMs: 10000 },
    goal: 'Publish a concise report about this synthetic thinking-limit fixture without visiting a website.',
    contract: { deliverable: 'report', requiredFields: [], filters: [], requiredSources: [] },
  },
);
