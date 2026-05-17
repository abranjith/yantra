import type { WorkflowFile } from '@yantra/protocol';

import type { LintFinding, LintRule } from '../index.js';

const CREDENTIAL_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AKIA[A-Z0-9]{16}/,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
];

const OPAQUE_REF_PATTERN = /^\{\{\s*(secret|param|capture):[a-z0-9_.-]+\s*\}\}$/;

function isHighEntropy(s: string): boolean {
  if (s.length < 24) return false;
  const uniqueChars = new Set(s).size;
  const hasUpper = /[A-Z]/.test(s);
  const hasLower = /[a-z]/.test(s);
  const hasDigit = /[0-9]/.test(s);
  const hasSpecial = /[^A-Za-z0-9]/.test(s);
  const mixScore =
    (hasUpper ? 1 : 0) + (hasLower ? 1 : 0) + (hasDigit ? 1 : 0) + (hasSpecial ? 1 : 0);
  return uniqueChars >= 12 && mixScore >= 3;
}

function looksLikeCredential(value: string): boolean {
  if (OPAQUE_REF_PATTERN.test(value)) return false;
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(value)) return true;
  }
  if (isHighEntropy(value)) return true;
  return false;
}

function extractStringValues(workflow: WorkflowFile): { path: string; value: string }[] {
  const results: { path: string; value: string }[] = [];

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    if (!step) continue;

    if (step.verb === 'fill' && typeof step.value === 'string') {
      results.push({ path: `steps[${i}].value`, value: step.value });
    }

    if (step.verb === 'navigate' && typeof step.url === 'string') {
      results.push({ path: `steps[${i}].url`, value: step.url });
    }

    if (step.verb === 'call_workflow') {
      for (const [paramKey, paramVal] of Object.entries(step.params)) {
        if (typeof paramVal === 'string') {
          results.push({ path: `steps[${i}].params.${paramKey}`, value: paramVal });
        }
      }
    }
  }

  return results;
}

export const secretShapedLiteral: LintRule = {
  name: 'SecretShapedLiteralInValue',
  check(workflow: WorkflowFile): LintFinding[] {
    const findings: LintFinding[] = [];
    const candidates = extractStringValues(workflow);

    for (const { path, value } of candidates) {
      if (looksLikeCredential(value)) {
        findings.push({
          code: 'SecretShapedLiteralInValue',
          severity: 'error',
          path,
          message: `Value at "${path}" looks like a secret or credential literal.`,
          suggestion:
            'Move the value to a secret store and reference it with {{ secret:namespace.key }}.',
        });
      }
    }

    return findings;
  },
};
