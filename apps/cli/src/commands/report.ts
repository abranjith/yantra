/**
 * `yantra report <run-id>` — prints (or opens) the per-run report.md.
 *
 * Stdout path: emits the markdown verbatim. `--open` shells out to
 * `$EDITOR` (or platform default: `notepad.exe`, `open`, `xdg-open`).
 *
 * Deliberately conservative — no shell-out beyond `$EDITOR` and the OS
 * defaults. Memory.md §General "honesty over cleverness" applies here.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LocalRunStore } from '@yantra/core/workflow/replay';

import { CLIConnectorIO, buildRenderOpts } from '../connector-io.js';
import { readGlobalFlags } from '../global-flags.js';
import type { HandlerArgs } from '../registry/handler.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';

interface ReportOptions {
  readonly open?: boolean;
  readonly json?: boolean;
}

/** `yantra report`: bound to the `report` registry entry. */
export async function reportHandler(args: HandlerArgs, options: ReportOptions): Promise<void> {
  const [runId] = args as readonly [string];
  const flags = readGlobalFlags({
    argv: process.argv,
    env: process.env,
    isTty: process.stdout.isTTY ?? false,
  });
  const isJson = options.json === true || flags.json;

  try {
    const runStore = new LocalRunStore();
    const run = await runStore.getRun(runId);
    if (run === null) {
      process.stderr.write(`Run "${runId}" not found.\n`);
      process.exit(1);
    }
    const reportPath = join(run.runDir, 'report.md');

    if (options.open === true) {
      if (isJson) {
        process.stderr.write('--open is interactive and cannot be combined with --json.\n');
        process.exit(1);
      }
      openInEditor(reportPath);
      process.exit(0);
    }

    let markdown: string;
    try {
      markdown = await readFile(reportPath, 'utf8');
    } catch {
      process.stderr.write(
        `report.md not found for run ${runId} (the run may still be in progress).\n`,
      );
      process.exit(1);
    }

    const renderer = isJson ? new JSONRenderer() : new TerminalRenderer();
    const connector = new CLIConnectorIO(renderer);
    connector.renderResult(
      { kind: 'report', markdown },
      buildRenderOpts({ ...flags, json: isJson }),
    );
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

function openInEditor(path: string): void {
  const editor = process.env.EDITOR ?? defaultPlatformEditor();
  const child = spawn(editor, [path], { stdio: 'inherit', shell: false });
  child.on('error', (err) => {
    process.stderr.write(`Failed to launch ${editor}: ${err.message}\n`);
    process.exit(1);
  });
}

function defaultPlatformEditor(): string {
  if (process.platform === 'win32') return 'notepad.exe';
  if (process.platform === 'darwin') return 'open';
  return 'xdg-open';
}
