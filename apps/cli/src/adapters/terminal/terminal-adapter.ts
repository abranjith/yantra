import { fileURLToPath } from 'node:url';

import { NodeDaemonProcessControl } from '@yantra/core';
import { InteractiveConfirmationGateway, InteractiveInstallOfferGateway } from '@yantra/core';
import { parseInvocation } from '@yantra/protocol';

import type { CommandContext } from '../../context/command-context.js';
import { SettingsResolver } from '../../context/settings-resolver.js';
import { executeCommand } from '../../execute.js';
import type { CliRunOptions } from '../../program.js';
import type { HandlerTable } from '../../registry/build-command-tree.js';
import { buildHandlers } from '../../registry/handlers.js';
import { JSONRenderer } from '../../render/json.js';
import { makeStderrLogger } from '../../runtime.js';

import { CLIConnectorIO } from './connector.js';
import { openArtifact } from './open-artifact.js';
import { terminalInputs, terminalInitCollector } from './prompts.js';

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
    initAnswers: terminalInitCollector(),
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
    input: terminalInputs(tty, { env: options.env ?? process.env }),
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
  const context = createTerminalContext({
    ...legacy,
    ...terminal,
    signal: terminal.signal ?? controller.signal,
  });
  const handlers: HandlerTable = buildHandlers(options, context);
  const parsed = parseInvocation([...argv], { cwd: context.cwd });
  const binding = parsed.isOk ? handlers[parsed.value.entry.id] : undefined;
  const dispose = wireTerminalSignals(
    controller,
    () => typeof binding === 'function' && binding.honorsAbort === true,
  );
  try {
    return (await executeCommand(argv, context, options, handlers)).exitCode;
  } finally {
    dispose();
  }
}

/** Unsupported handlers retain the terminal's conventional signal exit. */
export function wireTerminalSignals(
  controller: AbortController,
  honorsAbort: () => boolean,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  const signal = (name: 'SIGINT' | 'SIGTERM') => {
    if (honorsAbort()) controller.abort(name);
    else exit(name === 'SIGINT' ? 130 : 143);
  };
  const interrupt = () => signal('SIGINT'),
    terminate = () => signal('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  return () => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  };
}
