import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { terminalInputs } from '../../src/adapters/terminal/prompts.js';
describe('@no-llm terminal piped input', () => {
  it('preserves a multibyte credential split across input chunks', async () => {
    const value = 'CANARY-\u{1f30d}-\u00e9\n';
    const bytes = Buffer.from(value, 'utf8');
    const input = Readable.from([...bytes].map((byte) => Buffer.from([byte])));
    expect(await terminalInputs(false, { stdin: input }).stdin()).toBe(value);
  });
});

describe('@no-llm terminal editor capability', () => {
  it('honors configured editor commands with flags through the terminal boundary', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const launch = vi.fn(() => child) as unknown as typeof spawn;
    const pending = terminalInputs(false, { env: { EDITOR: 'code --wait' }, spawn: launch }).editor(
      'C:/fixture home/config.yaml',
    );
    child.emit('exit', 0);
    expect(await pending).toBe(true);
    expect(launch).toHaveBeenCalledWith('code --wait', ['C:/fixture home/config.yaml'], {
      stdio: 'inherit',
      shell: true,
    });
  });
  it('launches the platform default without a shell for report opening', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const launch = vi.fn(() => child) as unknown as typeof spawn;
    const pending = terminalInputs(false, { env: {}, spawn: launch }).editor('/fixture/report.md', {
      wait: false,
    });
    child.emit('spawn');
    expect(await pending).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(expect.any(String), ['/fixture/report.md'], {
      stdio: 'inherit',
      shell: false,
    });
  });
});
