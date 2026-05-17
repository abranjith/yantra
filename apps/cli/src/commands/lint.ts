import { loadWorkflow, lint } from '@yantra/core';
import type { LintReport, LintFinding } from '@yantra/core';
import { Command } from 'commander';

function formatFinding(finding: LintFinding): string {
  const severity = finding.severity.toUpperCase().padEnd(7);
  const parts = [severity, finding.path, finding.code, finding.message];
  let line = parts.join('  ');
  if (finding.suggestion) {
    line += `\n         → ${finding.suggestion}`;
  }
  return line;
}

function printReport(report: LintReport): void {
  const allFindings = [...report.errors, ...report.warnings, ...report.infos];

  for (const finding of allFindings) {
    process.stdout.write(formatFinding(finding) + '\n');
  }

  const errorCount = report.errors.length;
  const warnCount = report.warnings.length;
  process.stdout.write(
    `\n${errorCount} error${errorCount !== 1 ? 's' : ''}, ${warnCount} warning${warnCount !== 1 ? 's' : ''}\n`,
  );
}

export function makeLintCommand(): Command {
  const cmd = new Command('lint');

  cmd
    .description('Lint a workflow YAML file for errors and best-practice violations')
    .argument('<file>', 'Path to the workflow YAML file')
    .option('--strict', 'Promote warnings to errors', false)
    .option('--json', 'Output lint report as JSON to stdout', false)
    .action(async (file: string, options: { strict: boolean; json: boolean }) => {
      const loadResult = await loadWorkflow(file);

      if (!loadResult.isOk) {
        const parseReport = loadResult.error;

        if (options.json) {
          process.stdout.write(JSON.stringify(parseReport, null, 2) + '\n');
        } else {
          printReport(parseReport);
        }

        process.exit(1);
      }

      const workflow = loadResult.value;
      const report = lint(workflow, { strict: options.strict });

      if (options.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        if (
          report.errors.length === 0 &&
          report.warnings.length === 0 &&
          report.infos.length === 0
        ) {
          process.stdout.write('No lint findings.\n');
        } else {
          printReport(report);
        }
      }

      const hasErrors = report.errors.length > 0;
      const hasWarningsInStrict = options.strict && report.warnings.length > 0;

      if (hasErrors || hasWarningsInStrict) {
        process.exit(1);
      }

      process.exit(0);
    });

  return cmd;
}
