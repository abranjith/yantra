import type { WorkflowFile } from '@yantra/protocol';

import type { LintFinding, LintRule } from '../index.js';

const PURCHASE_SHAPED_PATTERN =
  /\b(buy|pay|book|order|submit|purchase|checkout|confirm|place\s+order|complete\s+purchase)\b/i;

export const criticalActionWithoutConfirmation: LintRule = {
  name: 'CriticalActionWithoutConfirmation',
  check(workflow: WorkflowFile): LintFinding[] {
    const findings: LintFinding[] = [];
    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      if (!step) continue;
      if (step.verb !== 'click' && step.verb !== 'fill') continue;
      if (step.requires_confirmation) continue;
      const locatorName = 'locator' in step ? (step as { locator: string }).locator : '';
      const locatorCandidates = workflow._locators[locatorName] ?? [];
      const accessibleNames = locatorCandidates
        .map((c) => {
          if (c.kind === 'role' && typeof c.name === 'string') return c.name;
          if (c.kind === 'label') return c.value;
          if (c.kind === 'testid') return c.value;
          return '';
        })
        .join(' ');
      const textToCheck = `${locatorName} ${accessibleNames}`;
      if (PURCHASE_SHAPED_PATTERN.test(textToCheck)) {
        findings.push({
          code: 'CriticalActionWithoutConfirmation',
          severity: 'warning',
          path: `steps[${i}]`,
          message: `Step "${step.id}" looks like a purchase/submit action but does not have requires_confirmation set.`,
          suggestion:
            'Add `requires_confirmation: true` to this step so the executor pauses for human consent.',
        });
      }
    }
    return findings;
  },
};
