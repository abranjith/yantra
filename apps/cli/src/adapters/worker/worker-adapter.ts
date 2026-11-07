import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  collectInitProviderAnswers,
  collectInitContextGrants,
  NodeDaemonProcessControl,
} from '@yantra/core';
import {
  CommandResultMessageSchema,
  parseInvocation,
  type CommandInvocation,
  type CommandResultMessage,
  type JsonValue,
} from '@yantra/protocol';

import { CommandConnectorIO } from '../../connector-io.js';
import type { CommandContext } from '../../context/command-context.js';
import { SettingsResolver } from '../../context/settings-resolver.js';
import { executeCommand } from '../../execute.js';
import type { CliRunOptions } from '../../program.js';
import type { HandlerTable } from '../../registry/build-command-tree.js';
import { buildHandlers } from '../../registry/handlers.js';
import { JSONRenderer } from '../../render/json.js';
import { makeStderrLogger } from '../../runtime.js';

import type { InputRequest, WorkerChannel } from './channel.js';

const TEXT_CAP = 64 * 1024;
const TRUNCATED = '\n[output truncated]\n';
export interface WorkerRunOptions extends CliRunOptions {
  readonly handlers?: HandlerTable;
}
/** Execute an app invocation without acquiring a terminal or changing process state. */
export async function runWorkerInvocation(
  invocation: CommandInvocation,
  channel: WorkerChannel,
  env: Readonly<NodeJS.ProcessEnv>,
  options: WorkerRunOptions = {},
): Promise<CommandResultMessage> {
  const finish = (value: CommandResultMessage): CommandResultMessage => {
    const message = CommandResultMessageSchema.parse(value);
    channel.complete(message);
    return message;
  };
  const parsed = parseInvocation([...invocation.path, ...invocation.argv], {
    cwd: invocation.cwd,
    invocationId: invocation.invocation_id,
  });
  if (!parsed.isOk)
    return finish({
      type: 'error',
      exit_code: 1,
      code: parsed.error.code,
      message: parsed.error.message,
      remediation: parsed.error.suggestion ?? null,
    });
  if (parsed.value.execution === 'exemption' || parsed.value.execution === 'in-process-secure')
    return finish({
      type: 'error',
      exit_code: 1,
      code: 'not_worker_executable',
      message: 'This command must run in its designated secure or terminal surface.',
      remediation: null,
    });
  const controller = new AbortController();
  let chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  let envelope: JsonValue | null = null;
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      const data = Buffer.from(chunk as Uint8Array);
      if (bytes + data.length > TEXT_CAP) truncated = true;
      const keep = data.subarray(0, Math.max(0, TEXT_CAP - bytes));
      chunks.push(keep);
      bytes += keep.length;
      callback();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      channel.diagnostic(String(chunk));
      callback();
    },
  });
  const input = async (request: InputRequest): Promise<string | boolean | null> =>
    channel.attended() && !controller.signal.aborted
      ? channel.requestInput(request, controller.signal)
      : null;
  const text = async (
    kind: 'text' | 'password' | 'select',
    message: string,
    choices?: readonly string[],
  ): Promise<string | null> => {
    const value = await input({ kind, message, ...(choices === undefined ? {} : { choices }) });
    return typeof value === 'string' ? value : null;
  };
  const context: CommandContext = {
    initAnswers: {
      providerAnswers: () =>
        collectInitProviderAnswers({
          select: (message, choices) => context.input.select(message, choices),
          text: (message) => context.input.text(message),
          password: (message) => context.input.password(message),
        }),
      contextGrants: () =>
        collectInitContextGrants({
          confirm: (message) => context.input.confirm(message),
          text: (message) => context.input.text(message),
        }),
    },
    processes: new NodeDaemonProcessControl({
      entrypoint: fileURLToPath(new URL('../../bin.js', import.meta.url)),
      cwd: invocation.cwd,
      env,
    }),
    surface: 'worker',
    cwd: invocation.cwd,
    invocationId: invocation.invocation_id,
    signal: controller.signal,
    isInteractive: () => channel.attended(),
    settings: new SettingsResolver(env, undefined, {
      cwd: invocation.cwd,
      surface: 'worker',
      invocationId: invocation.invocation_id,
    }),
    logger: makeStderrLogger(false, stderr),
    output: {
      stdout,
      stderr,
      columns: null,
      colorCapable: false,
      json: (value) => {
        envelope = value as JsonValue;
      },
      jsonLine: (value) => channel.event(value),
    },
    input: {
      select: (message, choices) => text('select', message, choices),
      choose: (choices) => text('select', 'Choose a report template', choices),
      text: (message) => text('text', message),
      password: (message) => text('password', message),
      confirm: async (message) => {
        const value = await input({ kind: 'confirm', message });
        return typeof value === 'boolean' ? value : null;
      },
      stdin: () => Promise.resolve(null),
      editor: () => Promise.resolve(false),
    },
    gateways: {
      confirmation: (interactive) =>
        interactive && channel.attended()
          ? {
              request: async (request) => ({
                confirmation_id: request.confirmation_id,
                decision: await channel.requestConfirmation(request, controller.signal),
                decided_at: new Date().toISOString(),
                decided_by: 'user_interactive',
              }),
            }
          : null,
      installOffer: (interactive) =>
        interactive && channel.attended()
          ? {
              offer: async (offer) =>
                (await channel.requestInstallOffer(offer, controller.signal))
                  ? { accepted: true, source: 'interactive-offer' }
                  : null,
            }
          : null,
    },
    connector: (renderer, connectorOptions) =>
      new CommandConnectorIO(
        renderer instanceof JSONRenderer
          ? new JSONRenderer((value) => context.output.json(value))
          : renderer,
        connectorOptions === undefined
          ? undefined
          : {
              ...connectorOptions,
              output: context.output,
              interactive: channel.attended(),
              confirmationPrompt: (request, signal) =>
                channel.attended()
                  ? channel.requestConfirmation(request, signal)
                  : Promise.resolve('denied'),
            },
      ),
    openExternal: (path) => channel.diagnostic(`open: ${path}`),
  };
  const handlers: HandlerTable = { ...buildHandlers(options, context), ...options.handlers };
  const bound = handlers[parsed.value.entry.id];
  const dispose = channel.onCancel(() => {
    if (typeof bound === 'function' && bound.honorsAbort === true) controller.abort();
    else channel.diagnostic('cancel_unsupported');
  });
  try {
    const result = await executeCommand(
      [...invocation.path, ...invocation.argv],
      context,
      options,
      handlers,
    );
    if (result.failure && envelope === null)
      return finish({
        type: 'error',
        exit_code: result.exitCode === 0 ? 2 : result.exitCode,
        ...result.failure,
      });
    let output = Buffer.concat(chunks);
    chunks = [];
    if (truncated) output = output.subarray(0, TEXT_CAP - Buffer.byteLength(TRUNCATED));
    const captured =
      new TextDecoder().decode(output, { stream: truncated }) + (truncated ? TRUNCATED : '');
    return finish({ type: 'result', exit_code: result.exitCode, envelope, text: captured || null });
  } finally {
    dispose();
    stdout.destroy();
    stderr.destroy();
  }
}
