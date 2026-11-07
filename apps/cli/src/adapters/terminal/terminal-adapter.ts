import { fileURLToPath } from 'node:url';

import { NodeDaemonProcessControl } from '@yantra/core';
import { InteractiveConfirmationGateway, InteractiveInstallOfferGateway } from '@yantra/core';

import type { CommandContext } from '../../context/command-context.js';
import { SettingsResolver } from '../../context/settings-resolver.js';
import { executeCommand } from '../../execute.js';
import { openArtifact } from '../../open-artifact.js';
import type { CliRunOptions } from '../../program.js';
import { JSONRenderer } from '../../render/json.js';
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
  const settings = new SettingsResolver(options.env ?? process.env, undefined, {
    cwd: options.cwd ?? process.cwd(),

    surface: 'terminal',
    invocationId: null,
  });
  const context: CommandContext = {
    processes: new NodeDaemonProcessControl({
      entrypoint: fileURLToPath(new URL('../../bin.js', import.meta.url)),
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
    }),
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
    connector: (renderer, opts) =>
      new CLIConnectorIO(
        renderer instanceof JSONRenderer
          ? new JSONRenderer((value) => context.output.json(value))
          : renderer,
        opts ? { ...opts, output: context.output } : undefined,
      ),
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
  return context;
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
          : argv[0] === 'sites'
            ? options.sitesRuntime
            : argv[0] === 'template'
              ? options.templateRuntime
              : argv[0] === 'doctor'
                ? options.doctorRuntime
                : undefined;
  const controller = new AbortController();
  const interrupt = () => controller.abort('SIGINT');
  const terminate = () => controller.abort('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
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
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
