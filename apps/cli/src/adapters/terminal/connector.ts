import { createInterface } from 'node:readline/promises';

import type { ConfirmationRequest } from '@yantra/protocol';

import { CommandConnectorIO, type CliAgentConnectorOptions } from '../../connector-io.js';
import type { GlobalFlags } from '../../global-flags.js';
import type { ConnectorRenderOpts, OutputRenderer } from '../../render/types.js';

/** Terminal-specific defaults and readline consent; all rendering is shared. */
export class CLIConnectorIO extends CommandConnectorIO {
  public constructor(renderer: OutputRenderer, options?: CliAgentConnectorOptions) {
    const renderOpts = options?.renderOpts ?? {
      json: false,
      debug: false,
      noColor: true,
      stream: process.stdout,
      errStream: process.stderr,
    };
    super(renderer, {
      ...options,
      renderOpts,
      interactive: options?.interactive === true && !renderOpts.json,
      confirmationPrompt:
        options?.confirmationPrompt ??
        ((request, signal) => terminalConfirmation(request, signal, renderOpts.errStream)),
    });
  }
}
export async function terminalConfirmation(
  request: ConfirmationRequest,
  signal: AbortSignal,
  sink: NodeJS.WritableStream,
): Promise<'granted' | 'denied'> {
  sink.write(
    `\nConfirmation required\n  Action: ${request.action_kind}\n  Host: ${request.host}\n  Summary: ${request.description}\n  Consequence: ${request.consequence}\n`,
  );
  const readline = createInterface({ input: process.stdin, output: sink });
  try {
    const answer = await readline.question('Allow this action? [y/N] ', { signal });
    return /^(y|yes)$/i.test(answer.trim()) ? 'granted' : 'denied';
  } finally {
    readline.close();
  }
}

/** Compatibility default for command families awaiting context migration. */
export function buildRenderOpts(
  flags: GlobalFlags,
  streams: {
    readonly stdout?: NodeJS.WritableStream;
    readonly stderr?: NodeJS.WritableStream;
  } = {},
): ConnectorRenderOpts {
  return {
    json: flags.json,
    debug: flags.debug,
    noColor: flags.noColor,
    stream: streams.stdout ?? process.stdout,
    errStream: streams.stderr ?? process.stderr,
  };
}
