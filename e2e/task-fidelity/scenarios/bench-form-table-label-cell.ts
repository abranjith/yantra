/** Live-model layout benchmark; independent fixture truth. */
import { BENCHMARK_RULES } from '../fixtures/form-lab.js';
import type { Scenario } from '../scenario.js';
export const benchFormTableLabelCell: Scenario = {
  id: 'bench-form-table-label-cell',
  suite: 'do-benchmark',
  tiers: ['agentic'],
  command: 'do',
  sites: ['form-lab'],
  goal: 'Fill every field of the form at https://form-lab.yantra.test/table-label-cell with suitable test data, then take a full-page screenshot. Do not submit the form.',
  contract: {
    deliverable: 'actions',
    requiredFields: [],
    filters: [],
    requiredSources: [],
    actionTruth: {
      page: 'table-label-cell',
      rules: BENCHMARK_RULES['table-label-cell']!,
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
