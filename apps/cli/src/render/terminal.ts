/**
 * Plain-text terminal renderer.
 *
 * Deliberately minimal — no boxen, no chalk, no ora. The CLI ships without
 * a TTY-decoration dependency to keep the bundle small and the renderer
 * easy to snapshot-test. Color is suppressed under `--no-color` /
 * `NO_COLOR` / non-TTY conditions.
 */

import type { TaskEvent } from '@yantra/protocol';

import type {
  AuditRenderReport,
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
  }

  renderReport(markdown: string, opts: ConnectorRenderOpts): void {
    opts.stream.write(markdown);
    if (!markdown.endsWith('\n')) opts.stream.write('\n');
  }

  renderEvent(event: TaskEvent, opts: ConnectorRenderOpts): void {
    if (!opts.debug) return;
    opts.errStream.write(`[event] ${event.kind}\n`);
  }
}
