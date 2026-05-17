/**
 * Run report renderer.
 *
 * Produces a human-readable Markdown report and a machine-readable JSON summary.
 *
 * Design constraints:
 * - NEVER include literal secret values in any output.
 * - Follows the Playwright call-log style for step details.
 * - Appends "Resume with: yantra resume <run-id>" footer for failed/paused runs.
 */

import type {
  EvaluatedOutputs,
  FailureDetail,
  RunJsonSummary,
  RunManifest,
  RunReport,
} from './types.js';

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

/**
 * Renders a full Markdown report from a completed run.
 */
export function renderRunReport(report: RunReport): string {
  const sections: string[] = [];

  sections.push(renderSummarySection(report.manifest));
  sections.push(renderStepsSection(report.stepLog));

  if (report.outputs !== undefined) {
    sections.push(renderOutputsSection(report.outputs));
  }

  if (report.failure !== undefined) {
    sections.push(renderFailureSection(report.failure));
  }

  sections.push(renderAuditSection(report.auditEntries));

  if (report.manifest.status === 'failed' || report.manifest.status === 'paused') {
    sections.push(`---\n\n> **Resume with:** \`yantra resume ${report.manifest.runId}\``);
  }

  return sections.join('\n\n');
}

function renderSummarySection(manifest: RunManifest): string {
  const statusEmoji = statusIcon(manifest.status);
  const duration =
    manifest.durationMs !== undefined ? ` · ${(manifest.durationMs / 1000).toFixed(1)}s` : '';
  const header = `## Run Report — ${manifest.runId}`;
  const rows = [
    `| Field | Value |`,
    `|---|---|`,
    `| Status | ${statusEmoji} ${manifest.status} |`,
    `| Workflow | \`${manifest.workflowName}\` |`,
    `| Started | ${manifest.startedAt} |`,
    manifest.endedAt ? `| Ended | ${manifest.endedAt}${duration} |` : null,
    manifest.failureClass ? `| Failure class | \`${manifest.failureClass}\` |` : null,
    manifest.chromeDriftWarning
      ? `| ⚠ Chrome drift | ${manifest.chromeDriftWarning.recorded} → ${manifest.chromeDriftWarning.current} |`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  return `${header}\n\n${rows}`;
}

function statusIcon(status: string): string {
  const icons: Record<string, string> = {
    completed: '✅',
    failed: '❌',
    paused: '⏸',
    aborted: '🛑',
    running: '▶',
    queued: '⏳',
  };
  return icons[status] ?? '?';
}

function renderStepsSection(stepLog: RunReport['stepLog']): string {
  if (!stepLog || stepLog.length === 0) return '## Steps\n\n_No steps recorded._';

  const lines = ['## Steps', ''];
  for (const entry of stepLog) {
    const icon = entry.status === 'ok' ? '✅' : '❌';
    const dur = entry.durationMs !== undefined ? ` (${(entry.durationMs / 1000).toFixed(2)}s)` : '';
    lines.push(`${icon} **${entry.stepId}** — \`${entry.type}\`${dur}`);
    if (entry.error) {
      lines.push(`   > Error: ${entry.error}`);
    }
  }

  return lines.join('\n');
}

function renderOutputsSection(outputs: EvaluatedOutputs): string {
  const entries = Object.entries(outputs.persisted);

  if (entries.length === 0 && outputs.errors.length === 0) {
    return '## Outputs\n\n_No outputs produced._';
  }

  const lines = ['## Outputs', ''];

  for (const [name, value] of entries) {
    const formatted =
      typeof value === 'object' && value !== null
        ? '```json\n' + JSON.stringify(value, null, 2) + '\n```'
        : `\`${String(value)}\``;
    lines.push(`**${name}**: ${formatted}`);
  }

  if (outputs.errors.length > 0) {
    lines.push('', '### Output Evaluation Errors', '');
    for (const e of outputs.errors) {
      lines.push(`- \`${e.name}\`: ${e.error}`);
    }
  }

  return lines.join('\n');
}

function renderFailureSection(failure: FailureDetail): string {
  const lines = ['## Failure Detail', ''];

  lines.push(`**Failure class:** \`${failure.failureClass}\``);
  lines.push(`**Step:** \`${failure.stepId}\``);
  lines.push(`**Message:** ${failure.message}`);

  if (failure.failureClass === 'locator_miss_in_unrecorded_frame') {
    lines.push('');
    lines.push(
      '> **Unrecorded frame limitation**: The locator failure occurred on a page that was',
    );
    lines.push('> not visible during the original recording. Dynamic content (popups, iframes,');
    lines.push('> redirects) that appeared during replay cannot be targeted by recorded locators.');
    lines.push('> Re-record the workflow to capture this frame.');
  }

  return lines.join('\n');
}

function renderAuditSection(auditEntries: RunReport['auditEntries']): string {
  if (!auditEntries || auditEntries.length === 0) {
    return '## Audit\n\n_No audit events._';
  }

  const lines = ['## Audit', '', '```'];
  for (const entry of auditEntries) {
    lines.push(JSON.stringify(entry));
  }
  lines.push('```');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON summary
// ---------------------------------------------------------------------------

/**
 * Produces a machine-readable compact summary for piping / CI integrations.
 */
export function renderJsonSummary(report: RunReport): RunJsonSummary {
  const stepCount = report.stepLog?.length ?? 0;
  const failedSteps = report.stepLog?.filter((s) => s.status !== 'ok').length ?? 0;

  return {
    runId: report.manifest.runId,
    workflowName: report.manifest.workflowName,
    status: report.manifest.status,
    startedAt: report.manifest.startedAt,
    endedAt: report.manifest.endedAt,
    durationMs: report.manifest.durationMs,
    stepCount,
    failedSteps,
    failureClass: report.manifest.failureClass,
    outputs: report.outputs ? Object.keys(report.outputs.persisted) : [],
  };
}

// ---------------------------------------------------------------------------
// ReportRenderer class (DI-friendly wrapper)
// ---------------------------------------------------------------------------

export class MarkdownReportRenderer {
  public render(report: RunReport): string {
    return renderRunReport(report);
  }

  public renderJson(report: RunReport): RunJsonSummary {
    return renderJsonSummary(report);
  }
}
