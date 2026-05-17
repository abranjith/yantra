import { readFile } from 'node:fs/promises';

import { WorkflowFile, ok, err, type Result } from '@yantra/protocol';
import * as YAML from 'yaml';

import type { LintReport, LintFinding } from '../lint/index.js';

import { fromShortForm } from './short-form.js';

/**
 * Load and validate a workflow YAML file.
 * Returns Result<WorkflowFile, LintReport>.
 * Throws on I/O errors (not represented in LintReport).
 */
export async function loadWorkflow(filePath: string): Promise<Result<WorkflowFile, LintReport>> {
  const raw = await readFile(filePath, 'utf-8');
  return parseWorkflowYaml(raw);
}

/**
 * Parse a workflow YAML string.
 * Exported for testing without filesystem.
 */
export function parseWorkflowYaml(yamlText: string): Result<WorkflowFile, LintReport> {
  let parsed: unknown;

  try {
    parsed = YAML.parse(yamlText);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Extract line:col from YAML parse error if available
    const lineColMatch = /at line (\d+), column (\d+)/.exec(message);
    const path = lineColMatch ? `${lineColMatch[1]}:${lineColMatch[2]}` : '<unknown>';

    const finding: LintFinding = {
      code: 'YamlSyntax',
      severity: 'error',
      path,
      message: `YAML syntax error: ${message}`,
      suggestion: null,
    };

    return err({
      errors: [finding],
      warnings: [],
      infos: [],
    });
  }

  // Desugar short-forms on each step
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'steps' in parsed &&
    Array.isArray((parsed as Record<string, unknown>).steps)
  ) {
    const obj = parsed as Record<string, unknown>;
    const steps = obj.steps as unknown[];
    obj.steps = steps.map((step, index) => fromShortForm(step, index));
  }

  // Zod validate
  const result = WorkflowFile.safeParse(parsed);
  if (!result.success) {
    const findings: LintFinding[] = result.error.issues.map((issue) => ({
      code: 'SchemaInvalid',
      severity: 'error' as const,
      path: issue.path.join('.') || '<root>',
      message: issue.message,
      suggestion: null,
    }));

    return err({
      errors: findings,
      warnings: [],
      infos: [],
    });
  }

  return ok(result.data);
}
