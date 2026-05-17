import type { WorkflowFile } from '@yantra/protocol';

import type { LintFinding, LintRule } from '../index.js';

export const outputsUnredactedWithoutReadOnly: LintRule = {
  name: 'OutputsUnredactedWithoutReadOnly',
  check(workflow: WorkflowFile): LintFinding[] {
    const findings: LintFinding[] = [];

    if (!workflow.outputs_unredacted) return findings;

    const hasReadOnlyStep = workflow.steps.some((step) => step.scope === 'read-only-data');

    if (!hasReadOnlyStep) {
      findings.push({
        code: 'OutputsUnredactedWithoutReadOnly',
        severity: 'warning',
        path: 'outputs_unredacted',
        message:
          'outputs_unredacted is true but no step has scope "read-only-data". This flag is typically used to allow unredacted output from read-only steps.',
        suggestion:
          'Either add scope: read-only-data to the relevant extract step, or set outputs_unredacted: false.',
      });
    }

    return findings;
  },
};
