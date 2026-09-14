/** Explicit, consented managed-browser commands. */
import {
  createLocalBrowserRuntimeServices,
  managedBrowsersRoot,
  type ManagedInstallOutcome,
  type ManagedInstallService,
} from '@yantra/core';
import { Command, CommanderError } from 'commander';
import prompts from 'prompts';

import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';

interface InstallOptions {
  readonly yes?: boolean;
  readonly json?: boolean;
}

export interface BrowserCommandRuntime {
  readonly service?: ManagedInstallService;
  readonly isTty?: () => boolean;
  readonly prompt?: typeof prompts;
  readonly destinationRoot?: () => string;
  readonly now?: () => Date;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

const APPROXIMATE_BYTES = 200 * 1024 * 1024;

/** Creates the extensible `yantra browser` command group. */
export function makeBrowserCommand(runtime: BrowserCommandRuntime = {}): Command {
  const service = runtime.service ?? createLocalBrowserRuntimeServices().installService!;
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const isTty = runtime.isTty ?? (() => process.stdin.isTTY === true);
  const prompt = runtime.prompt ?? prompts;
  const destinationRoot = runtime.destinationRoot ?? managedBrowsersRoot;
  const now = runtime.now ?? (() => new Date());
  const browser = new Command('browser').description('Manage Yantra-owned browser installations');

  browser
    .command('install')
    .description('Download current Chrome for Testing Stable into Yantra-managed storage')
    .option('--yes', 'accept the download without prompting', false)
    .option('--json', 'emit exactly one JSON outcome', false)
    .action(async (options: InstallOptions) => {
      const destination = destinationRoot();
      if (options.yes !== true && (!isTty() || options.json === true)) {
        const message =
          '`yantra browser install --yes` is required for JSON or non-interactive use.';
        stderr.write(`${message}\n`);
        if (options.json)
          writeJson(stdout, destination, {
            status: 'failed',
            error: {
              code: 'consent-required',
              phase: 'preflight',
              remediation: 'Pass --yes only after reviewing the download notice.',
              detail: message,
              retainedOrphan: null,
            },
          });
        throw new CommanderError(1, 'yantra.browser.install.consent-required', message);
      }

      stderr.write(
        `Chrome for Testing Stable will be downloaded to ${destination} (about 200 MB). Failed downloads restart from zero; external Chrome installations are untouched.\n`,
      );
      let granted = options.yes === true;
      if (!granted) {
        const answer = (await prompt({
          type: 'confirm',
          name: 'granted',
          message: 'Download managed Chrome?',
          initial: false,
        })) as { granted?: boolean };
        granted = answer.granted === true;
      }
      if (!granted) {
        const outcome = { status: 'cancelled', at: 'preflight', retainedOrphan: null } as const;
        if (options.json) writeJson(stdout, destination, outcome);
        stderr.write('Browser download was declined; no installation state changed.\n');
        throw new CommanderError(
          4,
          'yantra.browser.install.declined',
          'Browser download was declined.',
        );
      }

      const outcome = await service.install({
        trigger: 'explicit-command',
        consent: {
          granted: true,
          source: options.yes === true ? 'cli-accept-flag' : 'cli-prompt',
          grantedAt: now().toISOString(),
          destinationRoot: destination,
          approximateBytes: APPROXIMATE_BYTES,
        },
        onProgress: (event) =>
          stderr.write(
            `${event.phase}${event.percent === undefined ? '' : ` ${event.percent}%`}${event.interruptible ? '' : ' (finishing; cancellation pending)'}\n`,
          ),
      });

      if (options.json) {
        writeJson(stdout, destination, outcome);
        if (outcome.status === 'failed')
          stderr.write(`${outcome.error.detail} ${outcome.error.remediation}\n`);
        if (outcome.status === 'cancelled')
          stderr.write(`Browser installation was cancelled during ${outcome.at}.\n`);
      } else renderTerminal(stdout, stderr, outcome);
      if (outcome.status === 'cancelled')
        throw new CommanderError(
          4,
          'yantra.browser.install.cancelled',
          'Browser installation was cancelled.',
        );
      if (outcome.status === 'failed')
        throw new CommanderError(
          exitCodeFor(outcome.error.code),
          `yantra.browser.install.${outcome.error.code}`,
          `${outcome.error.detail} ${outcome.error.remediation}`,
        );
    });
  return browser;
}

function writeJson(
  stream: NodeJS.WritableStream,
  destinationRoot: string,
  outcome: ManagedInstallOutcome,
): void {
  stream.write(
    `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: 'browser_install', destinationRoot, outcome })}\n`,
  );
}

function renderTerminal(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  outcome: ManagedInstallOutcome,
): void {
  if (outcome.status === 'installed') {
    stdout.write(
      `Installed managed Chrome ${outcome.record.buildId} at ${outcome.executablePath}.\n`,
    );
    if (!outcome.selection.selectsThisInstallation && outcome.selection.command)
      stderr.write(`This installation is not selected. Run ${outcome.selection.command}.\n`);
  } else if (outcome.status === 'already-installed') {
    stdout.write(
      `Managed Chrome ${outcome.record.buildId} is already installed at ${outcome.executablePath}. To replace it, run ${outcome.updateCommand}.\n`,
    );
  } else if (outcome.status === 'cancelled') {
    stderr.write(
      `Browser installation was cancelled during ${outcome.at}; an interrupted download restarts from zero.\n`,
    );
  } else {
    stderr.write(`${outcome.error.detail} ${outcome.error.remediation}\n`);
  }
}

function exitCodeFor(
  code: Extract<ManagedInstallOutcome, { status: 'failed' }>['error']['code'],
): number {
  return code === 'consent-required' ? 1 : 3;
}
