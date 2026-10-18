import { equals } from '../expectations.js';
import { progressScenario } from '../progress-support.js';

import { contractStep, publishFormStep } from './do-form.js';
export const doTurnLimitRecovers = progressScenario(
  'do-turn-limit-recovers',
  [
    contractStep({ deliverable: 'report', subject: 'a fixture answer' }),
    { kind: 'think', ms: 12000 },
    publishFormStep(),
  ],
  ['steer'],
  [
    {
      id: 'one-thinking-abort',
      owner: 'FEAT-059',
      measure: (run) =>
        (run.artifacts.runHealth as { progress?: { turns?: { turn_limit_aborts?: number } } })
          ?.progress?.turns?.turn_limit_aborts,
      target: equals(1),
      note: 'A long thinking phase is aborted, then the same session publishes.',
    },
  ],
  {
    budgets: { turnTimeoutMs: 10000 },
    goal: 'Publish a concise report about this synthetic thinking-limit fixture without visiting a website.',
    contract: { deliverable: 'report', requiredFields: [], filters: [], requiredSources: [] },
  },
);
