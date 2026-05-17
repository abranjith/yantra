import type { WorkflowFile } from '@yantra/protocol';

import type { LintFinding, LintRule } from '../index.js';

function collectReferencedLocators(workflow: WorkflowFile): Set<string> {
  const referenced = new Set<string>();

  for (const step of workflow.steps) {
    if (
      step.verb === 'click' ||
      step.verb === 'fill' ||
      step.verb === 'extract' ||
      step.verb === 'wait_for' ||
      step.verb === 'assert'
    ) {
      referenced.add(step.locator);
    }
  }

  return referenced;
}

export const orphanedLocator: LintRule = {
  name: 'OrphanedLocator',
  check(workflow: WorkflowFile): LintFinding[] {
    const findings: LintFinding[] = [];
    const referenced = collectReferencedLocators(workflow);

    for (const key of Object.keys(workflow._locators)) {
      if (!referenced.has(key)) {
        findings.push({
          code: 'OrphanedLocator',
          severity: 'warning',
          path: `_locators["${key}"]`,
          message: `Locator "${key}" is defined in _locators but not referenced by any step.`,
          suggestion: 'Remove the locator if it is no longer needed, or add a step that uses it.',
        });
      }
    }

    return findings;
  },
};
