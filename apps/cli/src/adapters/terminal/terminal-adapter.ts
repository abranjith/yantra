import { InteractiveConfirmationGateway, InteractiveInstallOfferGateway } from '@yantra/core';

import type { CommandContext } from '../../context/command-context.js';
import { SettingsResolver } from '../../context/settings-resolver.js';
import { executeCommand } from '../../execute.js';
import { openArtifact } from '../../open-artifact.js';
import type { CliRunOptions } from '../../program.js';
import { makeStderrLogger } from '../../runtime.js';

import { CLIConnectorIO } from './connector.js';
import { terminalInputs } from './prompts.js';

/** Optional terminal capabilities also let tests supply hermetic streams and input. */
export interface TerminalOptions {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly isTty?: boolean;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}
export function createTerminalContext(options: TerminalOptions = {}): CommandContext {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const tty = options.isTty ?? process.stdin.isTTY === true;
  const settings = new SettingsResolver(options.env ?? process.env);
  return {
    surface: 'terminal',
    cwd: options.cwd ?? process.cwd(),
    invocationId: null,
    signal: options.signal ?? new AbortController().signal,
    output: {
      stdout,
      stderr,
      columns: (stdout as NodeJS.WriteStream).columns ?? null,
      colorCapable: (stdout as NodeJS.WriteStream).isTTY === true,
      json: (value, opts) => {
        stdout.write(`${JSON.stringify(value, null, opts?.indent)}\n`);
      },
      jsonLine: (value) => {
        stdout.write(`${JSON.stringify(value)}\n`);
      },
    },
    settings,
    logger: makeStderrLogger(false, stderr),
    input: terminalInputs(tty),
    isInteractive: ({ json }) => tty && !json,
    connector: (renderer, opts) => new CLIConnectorIO(renderer, opts),
    gateways: {
      confirmation: (interactive) =>
        interactive ? new InteractiveConfirmationGateway({ sink: stderr }) : null,
      installOffer: (interactive) =>
        interactive ? new InteractiveInstallOfferGateway({ sink: stderr, isTty: () => tty }) : null,
    },
    openExternal: (path) => {
      openArtifact(path);
    },
  };
}
export async function runTerminal(
  argv: readonly string[],
  options: CliRunOptions = {},
  terminal: TerminalOptions = {},
): Promise<number> {
  const legacy =
    argv[0] === 'research'
      ? options.researchRuntime
      : argv[0] === 'ask'
        ? options.askRuntime
        : argv[0] === 'do'
          ? options.doRuntime
          : undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    return (
      await executeCommand(
        argv,
        createTerminalContext({
          ...legacy,
          ...terminal,
          signal: terminal.signal ?? controller.signal,
        }),
        options,
      )
    ).exitCode;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
