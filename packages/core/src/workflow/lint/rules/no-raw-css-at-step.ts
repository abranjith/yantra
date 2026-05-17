import type { WorkflowFile } from '@yantra/protocol';

import type { LintFinding, LintRule } from '../index.js';

const RAW_CSS_PATTERN = /^(\.|#|\*|[a-z]+\[)/;

export const noRawCssAtStep: LintRule = {
  name: 'NoRawCssAtStep',
  check(workflow: WorkflowFile): LintFinding[] {
    const findings: LintFinding[] = [];

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      if (!step) continue;

      if (
        step.verb === 'click' ||
        step.verb === 'fill' ||
        step.verb === 'extract' ||
        step.verb === 'wait_for' ||
        step.verb === 'assert'
      ) {
        const { locator } = step;
        if (RAW_CSS_PATTERN.test(locator)) {
          findings.push({
            code: 'NoRawCssAtStep',
            severity: 'warning',
            path: `steps[${i}].locator`,
            message: `Step "${step.id}" uses a raw CSS-like locator "${locator}" instead of a named _locators key.`,
            suggestion: 'Add an entry to _locators with a descriptive name and reference it here.',
          });
        }
      }
    }

    return findings;
  },
};
