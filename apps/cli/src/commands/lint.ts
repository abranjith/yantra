import { resolve } from 'node:path';

import { loadWorkflow, lint } from '@yantra/core';
import type { LintReport, LintFinding } from '@yantra/core';
import { type Command } from 'commander';

import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import type { CommandContext } from '../context/command-context.js';
import { createRegisteredCommand } from '../registry/build-command-tree.js';
import { fromAction } from '../registry/handler.js';

function formatFinding(finding: LintFinding): string {
  const severity = finding.severity.toUpperCase().padEnd(7);
  const parts = [severity, finding.path, finding.code, finding.message];
  let line = parts.join('  ');
  if (finding.suggestion) {
    line += `\n         → ${finding.suggestion}`;
  }
  return line;
}

function printReport(context: CommandContext, report: LintReport): void {
  const allFindings = [...report.errors, ...report.warnings, ...report.infos];

  for (const finding of allFindings) {
    context.output.stdout.write(formatFinding(finding) + '\n');
  }

  const errorCount = report.errors.length;
  const warnCount = report.warnings.length;
  context.output.stdout.write(
    `\n${errorCount} error${errorCount !== 1 ? 's' : ''}, ${warnCount} warning${warnCount !== 1 ? 's' : ''}\n`,
  );
}

export function makeLintCommand(): Command {
  return createRegisteredCommand('lint', lintHandlers());
}

/** Handlers for `lint`, bound by registry id; each is its former commander action, unchanged. */
export function lintHandlers(context: CommandContext = createTerminalContext()) {
  return {
    lint: fromAction(async (file: string, options: { strict: boolean; json: boolean }) => {
      const loadResult = await loadWorkflow(resolve(context.cwd, file));

      if (!loadResult.isOk) {
        const parseReport = loadResult.error;

        if (options.json) {
          context.output.json(parseReport, { indent: 2 });
        } else {
          printReport(context, parseReport);
        }

        return { exitCode: 1 as const };
      }

      const workflow = loadResult.value;
      const report = lint(workflow, { strict: options.strict });

      if (options.json) {
        context.output.json(report, { indent: 2 });
      } else {
        if (
          report.errors.length === 0 &&
          report.warnings.length === 0 &&
          report.infos.length === 0
        ) {
          context.output.stdout.write('No lint findings.\n');
        } else {
          printReport(context, report);
        }
      }

      const hasErrors = report.errors.length > 0;
      const hasWarningsInStrict = options.strict && report.warnings.length > 0;

      if (hasErrors || hasWarningsInStrict) {
        return { exitCode: 1 as const };
      }

      return { exitCode: 0 as const };
    }),
  };
}
