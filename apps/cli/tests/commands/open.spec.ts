import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetPathCache } from '@yantra/core';
import { LocalRunStore } from '@yantra/core/workflow/replay';
import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeOpenCommand } from '../../src/commands/open.js';

describe('@no-llm open command', () => {
  let root: string;
  let savedHome: string | undefined;
  let output: string[];
  let errors: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-open-'));
    savedHome = process.env.YANTRA_HOME;
    process.env.YANTRA_HOME = root;
    resetPathCache();
    output = [];
    errors = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = savedHome;
    resetPathCache();
    await rm(root, { recursive: true, force: true });
  });

  async function run(args: readonly string[], launch = vi.fn(() => true)): Promise<void> {
    await makeOpenCommand({ launch, openHistory: async () => null })
      .exitOverride()
      .parseAsync([...args], { from: 'user' });
  }

  async function createRun(): Promise<{ readonly runId: string; readonly runDir: string }> {
    return new LocalRunStore().createAgentRun({ command: 'ask', taskId: 'task-1' });
  }

  it('uses the newest file-backed run when the optional index is unavailable', async () => {
    const created = await createRun();
    await writeFile(join(created.runDir, 'brief.md'), '# Brief');
    await run(['--print']);
    expect(output.join('')).toContain(join(created.runDir, 'brief.md'));
  });

  it('resolves an explicit run and launches its HTML brief', async () => {
    const created = await createRun();
    const path = join(created.runDir, 'brief.html');
    await writeFile(path, '<h1>Brief</h1>');
    const launch = vi.fn(() => true);
    await run([created.runId], launch);
    expect(launch).toHaveBeenCalledWith(path);
  });

  it('reports unknown runs and lists available artifacts for a missing selection', async () => {
    await expect(run(['missing', '--print'])).rejects.toBeInstanceOf(CommanderError);
    expect(errors.join('')).toContain('run "missing" was not found');
    errors = [];
    const created = await createRun();
    await writeFile(join(created.runDir, 'brief.md'), '# Brief');
    await expect(run([created.runId, '--artifact', 'report', '--print'])).rejects.toBeInstanceOf(
      CommanderError,
    );
    expect(errors.join('')).toContain('available: brief.md');
  });

  it('emits the versioned JSON shape without launching', async () => {
    const created = await createRun();
    const path = join(created.runDir, 'audit.json');
    await writeFile(path, '{}');
    const launch = vi.fn(() => true);
    await run([created.runId, '--artifact', 'audit', '--json'], launch);
    const result = JSON.parse(output.join('')) as Record<string, unknown>;
    expect(result).toMatchObject({ kind: 'open', runId: created.runId, artifact: 'audit', path });
    expect(result.schemaVersion).toBeDefined();
    expect(launch).not.toHaveBeenCalled();
  });
});
