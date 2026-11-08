import { spawn } from 'node:child_process';

import type { InitAnswerCollector } from '@yantra/core';
import prompts from 'prompts';

import type { InputCollector } from '../../context/command-context.js';

export interface TerminalInputDependencies {
  readonly stdin?: NodeJS.ReadableStream;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly spawn?: typeof spawn;
}
export function terminalInputs(
  interactive: boolean,
  deps: TerminalInputDependencies = {},
): InputCollector {
  const stdin = deps.stdin ?? process.stdin;
  const env = deps.env ?? process.env;
  const launch = deps.spawn ?? spawn;
  async function ask(
    type: 'select' | 'text' | 'confirm' | 'password',
    message: string,
    choices?: readonly string[],
  ): Promise<unknown> {
    if (!interactive) return null;
    const answer = (await prompts({
      type,
      name: 'value',
      message,
      ...(choices ? { choices: choices.map((value) => ({ title: value, value })) } : {}),
    })) as { value?: unknown };
    return answer.value ?? null;
  }
  const text = async (type: 'text' | 'password', message: string) => {
    const v = await ask(type, message);
    return typeof v === 'string' ? v : null;
  };
  return {
    select: async (message, choices) => {
      const v = await ask('select', message, choices);
      return typeof v === 'string' ? v : null;
    },
    choose: async (choices) => {
      const v = await ask('select', 'Choose a report template', choices);
      return typeof v === 'string' ? v : null;
    },
    text: (message) => text('text', message),
    password: (message) => text('password', message),
    confirm: async (message) => {
      const v = await ask('confirm', message);
      return typeof v === 'boolean' ? v : null;
    },
    stdin: async () => {
      stdin.setEncoding('utf8');
      let value = '';
      for await (const chunk of stdin) value += String(chunk);
      return value;
    },
    editor: async (path, options) => {
      const configuredEditor = env.EDITOR?.trim();
      const editor =
        configuredEditor !== undefined && configuredEditor !== ''
          ? configuredEditor
          : process.platform === 'win32'
            ? 'notepad.exe'
            : process.platform === 'darwin'
              ? 'open'
              : 'xdg-open';
      return new Promise<boolean>((resolve, reject) => {
        const child = launch(editor, [path], {
          stdio: 'inherit',
          shell: Boolean(configuredEditor),
        });
        child.once('error', reject);
        if (options?.wait === false)
          child.once('spawn', () => {
            child.unref();
            resolve(true);
          });
        else child.once('exit', (code) => resolve(code === 0));
      });
    },
  };
}

import { collectContextGrants } from './init-context-prompts.js';
import { runInitWizard } from './init-wizard.js';
export function terminalInitCollector(): InitAnswerCollector {
  return { providerAnswers: () => runInitWizard(), contextGrants: () => collectContextGrants() };
}
