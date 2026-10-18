/** Live-model layout benchmark; independent fixture truth. */
import { BENCHMARK_RULES } from '../fixtures/form-lab.js';
import type { Scenario } from '../scenario.js';
export const benchFormRepeatedSections: Scenario = {
  id: 'bench-form-repeated-sections',
  suite: 'do-benchmark',
  tiers: ['agentic'],
  command: 'do',
  sites: ['form-lab'],
  goal: 'Fill every field of the form at https://form-lab.yantra.test/repeated-sections with suitable test data, then take a full-page screenshot. Do not submit the form.',
  contract: {
    deliverable: 'actions',
    requiredFields: [],
    filters: [],
    requiredSources: [],
    actionTruth: {
      page: 'repeated-sections',
      rules: BENCHMARK_RULES['repeated-sections']!,
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
