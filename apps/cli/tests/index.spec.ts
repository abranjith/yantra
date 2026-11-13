import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { CommanderError } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProgram, run } from '../src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('@no-llm cli smoke', () => {
  it('prints a single-line protocol banner when invoked with no arguments', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const exitCode = await run([]);

    expect(writeSpy).toHaveBeenCalled();
    const message = (writeSpy.mock.calls[0]?.[0] as string | undefined) ?? '';
    expect(message).toContain('yantra');
    expect(message).toContain('protocol=0.0.1');
    expect(message).toContain('core=0.0.1');
    expect(message).toContain('agent=0.0.1');
    expect(exitCode).toBe(0);
  });

  it('prints the root help and maps the help exit to 0', async () => {
    // Arrange: production commander has no exitOverride, so `--help` ends in
    // process.exit(0). Intercept it as a CommanderError, which run() maps.
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new CommanderError(Number(code ?? 0), 'test.process-exit', '');
    });

    // Act
    const exitCode = await run(['--help']);

    // Assert: stdout is not a TTY under Vitest, so commander wraps at 80.
    expect(exitCode).toBe(0);
    const golden = await readFile(
      resolve(import.meta.dirname, 'fixtures', 'cli-surface', 'help', 'w80', 'root.txt'),
      'utf8',
    );
    expect(stdout).toBe(golden);
  });

  it('builds the program without parsing or writing anything', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const program = buildProgram();

    expect(program.name()).toBe('yantra');
    expect(program.commands.length).toBe(28);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('builds independent programs on every call', () => {
    expect(buildProgram()).not.toBe(buildProgram());
  });
});
