import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FailureClass, Plan } from '@yantra/protocol';

/**
 * Builds a human-readable `report.md` in the run directory.
 *
 * Format: call-log style (per brainstorm §7.6). Includes:
 * - Run metadata
 * - Step execution log
 * - Failure details (if applicable)
 * - Extraction error counts
 */
export interface ReportContext {
  readonly runId: string;
  readonly taskId: string;
  readonly plan: Plan;
  readonly status: 'completed' | 'failed' | 'handoff';
  readonly failureClass?: FailureClass;
  readonly failureMessage?: string;
  readonly failedAtStepId?: string;
  readonly completedStepIds: readonly string[];
  readonly captureKeys: readonly string[];
  readonly outputKeys: readonly string[];
}

export async function writeReport(runDir: string, ctx: ReportContext): Promise<string> {
  const reportPath = join(runDir, 'report.md');
  const content = buildReportContent(ctx);
  await writeFile(reportPath, content, 'utf8');
  return reportPath;
}

function buildReportContent(ctx: ReportContext): string {
  const lines: string[] = [];
  const ts = new Date().toISOString();

  lines.push(`# Yantra Run Report`);
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Run ID | \`${ctx.runId}\` |`);
  lines.push(`| Task ID | \`${ctx.taskId}\` |`);
  lines.push(`| Generated | ${ts} |`);
  lines.push(`| Status | **${ctx.status.toUpperCase()}** |`);
  if (ctx.failureClass) {
    lines.push(`| Failure Class | \`${ctx.failureClass}\` |`);
  }
  lines.push('');

  if (ctx.failureMessage) {
    lines.push(`## Failure`);
    lines.push('');
    lines.push('```');
    lines.push(ctx.failureMessage);
    lines.push('```');
    lines.push('');
  }

  lines.push(`## Step Log`);
  lines.push('');
  lines.push(`| Step | Type | Result |`);
  lines.push(`|---|---|---|`);

  for (const step of ctx.plan.steps) {
    const completed = ctx.completedStepIds.includes(step.id);
    const failed = ctx.failedAtStepId === step.id;
    const status = failed ? '❌ FAILED' : completed ? '✅ completed' : '⏭ skipped';
    lines.push(`| \`${step.id}\` | ${step.type} | ${status} |`);
  }
  lines.push('');

  if (ctx.captureKeys.length > 0) {
    lines.push(`## Captured Data`);
    lines.push('');
    lines.push(`Keys captured: ${ctx.captureKeys.map((k) => `\`${k}\``).join(', ')}`);
    lines.push('');
  }

  if (ctx.outputKeys.length > 0) {
    lines.push(`## Outputs`);
    lines.push('');
    lines.push(`Output keys: ${ctx.outputKeys.map((k) => `\`${k}\``).join(', ')}`);
    lines.push('');
  }

  return lines.join('\n');
}
