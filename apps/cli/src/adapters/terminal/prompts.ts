import { spawn } from 'node:child_process';

import prompts from 'prompts';

import type { InputCollector } from '../../context/command-context.js';

export function terminalInputs(interactive: boolean): InputCollector {
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
      let value = '';
      for await (const chunk of process.stdin) value += String(chunk);
      return value;
    },
    editor: async (path, options) => {
      const editor =
        process.env.EDITOR ??
        (process.platform === 'win32'
          ? 'notepad.exe'
          : process.platform === 'darwin'
            ? 'open'
            : 'xdg-open');
      return new Promise<boolean>((resolve, reject) => {
        const child = spawn(editor, [path], { stdio: 'inherit', shell: false });
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
