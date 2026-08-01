/**
 * Plain-text terminal renderer for structured command output
 * (`list`/`show`/`doctor`/`audit`/`report`).
 *
 * Intentionally plain — no boxen, chalk, or tables here. Note that the MVP's
 * blanket "the CLI ships without a TTY-decoration dependency" stance is no
 * longer true: plan §8 (FEAT-015) makes presentation a first-class concern and
 * the **Brief** surface adopts `boxen`/`chalk`/`cli-table3`/`marked-terminal`
 * in `render/brief-terminal.ts`. This renderer stays plain because its payloads
 * are terse operational tables, not documents. Color is suppressed under
 * `--no-color` / `NO_COLOR` / non-TTY conditions.
 */

import { briefToHtml, briefToMarkdown, templatedReportToHtml } from '@yantra/core';
import type { Brief, TaskEvent, TemplatedReport } from '@yantra/protocol';

import { renderBriefTerminal } from './brief-terminal.js';
import type {
  AuditRenderReport,
  BriefArtifactPaths,
  ConnectorRenderOpts,
  DoctorRenderResult,
  ListItem,
  OutputRenderer,
  ShowItem,
} from './types.js';

const STATUS_ICON: Record<'ok' | 'warn' | 'fail', string> = {
  ok: '✓',
  warn: '⚠',
  fail: '✗',
};

export class TerminalRenderer implements OutputRenderer {
  renderList(items: readonly ListItem[], opts: ConnectorRenderOpts): void {
    if (items.length === 0) {
      opts.stream.write('No items.\n');
      return;
    }
    const lines: string[] = [];
    for (const item of items) {
      if (item.kind === 'workflow') {
        lines.push(
          `${item.name.padEnd(28)}  steps=${item.stepCount.toString().padStart(3)}  ` +
            `class=${item.securityClass.padEnd(14)}  modified=${item.modifiedAt}`,
        );
      } else {
        const duration = item.durationMs === null ? '—' : `${item.durationMs}ms`;
        lines.push(
          `${item.runId.padEnd(48)}  ${item.status.padEnd(10)}  ${duration.padStart(8)}  ` +
            `workflow=${item.workflowName}`,
        );
      }
    }
    opts.stream.write(`${lines.join('\n')}\n`);
  }

  renderShow(item: ShowItem, opts: ConnectorRenderOpts): void {
    if (item.kind === 'workflow') {
      opts.stream.write(`# Workflow: ${item.name}\n\n`);
      opts.stream.write(item.yaml);
      if (!item.yaml.endsWith('\n')) opts.stream.write('\n');
      const counts = Object.entries(item.locatorCounts);
      if (counts.length > 0) {
        opts.stream.write('\n# Locator candidate counts\n');
        for (const [name, count] of counts) {
          opts.stream.write(`  ${name}: ${count}\n`);
        }
      }
    } else {
      opts.stream.write(`# Run: ${item.runId}\n\n`);
      opts.stream.write('## Manifest\n');
      opts.stream.write(`${JSON.stringify(item.manifest, null, 2)}\n`);
      opts.stream.write(`\n## Recent events (${item.events.length})\n`);
      for (const event of item.events) {
        opts.stream.write(`  - ${JSON.stringify(event)}\n`);
      }
    }
  }

  renderDoctor(result: DoctorRenderResult, opts: ConnectorRenderOpts): void {
    opts.stream.write(
      `yantra doctor — overall: ${STATUS_ICON[result.overall]} ${result.overall.toUpperCase()}\n`,
    );
    opts.stream.write(
      `  platform=${result.platform} node=${result.nodeVersion} version=${result.version}\n\n`,
    );
    for (const check of result.checks) {
      opts.stream.write(`  ${STATUS_ICON[check.status]} ${check.id.padEnd(36)} ${check.summary}\n`);
      if (check.remediation !== undefined && check.status !== 'ok') {
        opts.stream.write(`      → ${check.remediation}\n`);
      }
    }
  }

  renderAudit(report: AuditRenderReport, opts: ConnectorRenderOpts): void {
    opts.stream.write(`# Audit — run ${report.runId}\n\n`);
    opts.stream.write(`${report.trustNarrative}\n\n`);
    opts.stream.write(
      `Workflow:    ${report.workflowName}\n` +
        `Status:      ${report.status}\n` +
        `Started:     ${report.startedAt}\n` +
        `Ended:       ${report.endedAt ?? '—'}\n` +
        `Duration:    ${report.durationMs === null ? '—' : `${report.durationMs}ms`}\n\n`,
    );
    opts.stream.write(`Agent calls: ${report.llmCallCount}\n`);
    opts.stream.write(
      `Steps:       ${report.stepCount} ` +
        `(public=${report.scopeMix.publicCount}, ` +
        `read-only-data=${report.scopeMix.readOnlyDataCount}, ` +
        `authenticated=${report.scopeMix.authenticatedCount})\n`,
    );
    opts.stream.write(`Secrets used: ${report.secretLookups.length}\n`);
    if (report.secretLookups.length > 0) {
      for (const lookup of report.secretLookups) {
        opts.stream.write(`  • ${lookup.key} at step ${lookup.stepId}\n`);
      }
    }
    if (report.agent !== null) {
      opts.stream.write(
        `\nAgent:       ${report.agent.provider}/${report.agent.model} ` +
          `(thinking=${report.agent.thinking}, auth=${report.agent.authSource})\n`,
      );
      opts.stream.write(
        `Prompt:      ${report.agent.promptVersion} via ${report.agent.adapter} ${report.agent.sdkVersion}\n`,
      );
      opts.stream.write(`Raw session: ${report.agent.sessionFile}\n`);
    }
    if (report.usage !== null) {
      opts.stream.write(
        `Usage:       turns=${report.usage.turns} input=${report.usage.inputTokens ?? 'unknown'} ` +
          `output=${report.usage.outputTokens ?? 'unknown'} cost=${report.usage.costUsd ?? 'unknown'}\n`,
      );
    }
    if (report.terminalError !== null) {
      opts.stream.write(
        `\nTerminal error: ${report.terminalError.code} — ${report.terminalError.message}\n`,
      );
    }
    if (report.toolCalls.length > 0) {
      opts.stream.write('\nTool calls:\n');
      for (const call of report.toolCalls) {
        const incomplete = call.incomplete ? ' ⚠ incomplete' : '';
        const duration = call.durationMs === null ? '' : ` ${call.durationMs}ms`;
        const confirmation =
          call.confirmationId === null
            ? ''
            : ` confirmation=${call.confirmationId}` +
              (call.confirmationDecision === null ? '' : `:${call.confirmationDecision}`);
        opts.stream.write(
          `  #${call.seq} ${call.tool} — ${call.status}${duration}${confirmation}${incomplete}\n`,
        );
      }
    }
  }

  renderReport(markdown: string, opts: ConnectorRenderOpts): void {
    opts.stream.write(markdown);
    if (!markdown.endsWith('\n')) opts.stream.write('\n');
  }

  renderBrief(brief: Brief, artifacts: BriefArtifactPaths | null, opts: ConnectorRenderOpts): void {
    const format = opts.briefFormat ?? 'terminal';

    // `--format md|html` streams the portable artifact's exact content instead
    // of the ANSI view — same bytes the on-disk `brief.md`/`brief.html` carry.
    if (format === 'md') {
      opts.stream.write(`${briefToMarkdown(brief)}\n`);
      return;
    }
    if (format === 'html') {
      opts.stream.write(briefToHtml(brief));
      return;
    }

    const rendered = renderBriefTerminal(brief, {
      detail: opts.briefDetail ?? 'standard',
      noColor: opts.noColor,
      ...(opts.width !== undefined ? { width: opts.width } : {}),
    });
    opts.stream.write(`${rendered}\n`);

    if (artifacts !== null) {
      opts.stream.write(`\nSaved: ${artifacts.mdPath} · ${artifacts.htmlPath}\n`);
    }
  }

  renderTemplatedReport(
    report: TemplatedReport,
    _artifacts: BriefArtifactPaths | null,
    opts: ConnectorRenderOpts,
  ): void {
    if ((opts.briefFormat ?? 'terminal') === 'html') {
      opts.stream.write(templatedReportToHtml(report));
      return;
    }
    this.renderReport(report.rendered_md, opts);
  }

  renderEvent(event: TaskEvent, opts: ConnectorRenderOpts): void {
    if (!opts.debug) return;
    opts.errStream.write(`[event] ${event.kind}\n`);
  }
}
