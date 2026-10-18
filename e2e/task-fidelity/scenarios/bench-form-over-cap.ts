/** Live-model layout benchmark; independent fixture truth. */
import { BENCHMARK_RULES } from '../fixtures/form-lab.js';
import type { Scenario } from '../scenario.js';
export const benchFormOverCap: Scenario = {
  id: 'bench-form-over-cap',
  suite: 'do-benchmark',
  tiers: ['agentic'],
  command: 'do',
  sites: ['form-lab'],
  goal: 'Fill every field of the form at https://form-lab.yantra.test/over-cap with suitable test data, then take a full-page screenshot. Do not submit the form.',
  contract: {
    deliverable: 'actions',
    requiredFields: [],
    filters: [],
    requiredSources: [],
    actionTruth: {
      page: 'over-cap',
      rules: BENCHMARK_RULES['over-cap']!,
      artifacts: ['full_page'],
      submit: 'forbidden',
    },
  },
  userLocation: null,
  serps: [],
  script: [],
  expectations: [],
  truth: () => [],
};
