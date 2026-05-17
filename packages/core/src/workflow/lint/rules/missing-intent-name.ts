import type { WorkflowFile } from '@yantra/protocol';

import type { LintFinding, LintRule } from '../index.js';

const GENERIC_NAME_PATTERNS = [/^(locator|loc|elem)_\d+$/, /^[a-f0-9]{8,}$/];

function isGenericName(name: string): boolean {
  return GENERIC_NAME_PATTERNS.some((p) => p.test(name));
}

export const missingIntentName: LintRule = {
  name: 'MissingIntentName',
  check(workflow: WorkflowFile): LintFinding[] {
    const findings: LintFinding[] = [];

    for (const key of Object.keys(workflow._locators)) {
      if (isGenericName(key)) {
        findings.push({
          code: 'MissingIntentName',
          severity: 'warning',
          path: `_locators["${key}"]`,
          message: `Locator key "${key}" looks auto-generated. Give it a descriptive, human-readable name.`,
          suggestion:
            'Use a name like "Sign in button" or "Username field" that describes the element\'s intent.',
        });
      }
    }

    return findings;
  },
};
