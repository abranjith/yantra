import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { FileTemplateStore } from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTemplateCommand } from '../../src/commands/template.js';

function capture(): { readonly stream: Writable; readonly value: () => string } {
  let value = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += String(chunk);
        callback();
      },
    }),
    value: () => value,
  };
}

describe('@no-llm yantra template command', () => {
  let root: string;
  let sourceDir: string;
  let store: FileTemplateStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-template-cli-'));
    sourceDir = join(root, 'source');
    store = new FileTemplateStore(join(root, 'library'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function invoke(argv: readonly string[]): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }> {
    const stdout = capture();
    const stderr = capture();
    const command = makeTemplateCommand({
      store,
      cwd: sourceDir,
      stdout: stdout.stream,
      stderr: stderr.stream,
    }).exitOverride();
    let exitCode = 0;
    try {
      await command.parseAsync([...argv], { from: 'user' });
    } catch (error) {
      exitCode = (error as { exitCode?: number }).exitCode ?? 2;
    }
    return { exitCode, stdout: stdout.value(), stderr: stderr.value() };
  }

  it('new writes a starter template that lint accepts', async () => {
    const created = await invoke(['new', 'weekly', '--tags', 'Work,weekly']);
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain('weekly.md');

    const linted = await invoke(['lint', 'weekly']);
    expect(linted.exitCode).toBe(0);
    expect(linted.stdout).toContain('summary');
    expect(linted.stdout).toContain('table');
    expect(linted.stdout).toContain('sources');
  });

  it('lint reports broken placeholders with line numbers and exit 1', async () => {
    await store.save('broken', '# Report\n{{ broken\n');
    const result = await invoke(['lint', 'broken']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/line 2:.*missing closing/i);
  });

  it('lint --json has a stable envelope and works outside the store', async () => {
    await writeFile(
      join(root, 'external.md'),
      '---\nname: external\n---\n# External\n{{ body }}\n',
      'utf8',
    );
    const result = await invoke(['lint', '../external.md', '--json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: '0.2',
      kind: 'template_lint',
      ok: true,
      template: { name: 'external', slotCount: 1 },
      slots: [{ key: 'body', kind: 'markdown' }],
    });
  });

  it('save infers filename, normalizes metadata, and explicit name wins', async () => {
    await writeFile(
      join(root, 'Executive Report.md'),
      '---\ntags: [WORK, weekly, work]\n---\n# {{ title | text }}\n{{ body }}\n',
      'utf8',
    );
    const inferred = await invoke(['save', '../Executive Report.md']);
    expect(inferred.exitCode).toBe(0);
    expect(await store.exists('executive-report')).toBe(true);

    const explicit = await invoke([
      'save',
      '../Executive Report.md',
      '--name',
      'exec-brief',
      '--tags',
      'Weekly,WORK,weekly',
      '--description',
      '  Weekly   report  ',
    ]);
    expect(explicit.exitCode).toBe(0);
    const saved = await store.load('exec-brief');
    expect(saved).toContain('name: exec-brief');
    expect(saved).toContain('description: Weekly report');
    expect(saved).toMatch(/tags:\s*\n\s*- weekly\n\s*- work/u);
  });

  it('rejects an unparseable file before any write', async () => {
    await writeFile(join(root, 'bad.md'), '{{ bad', 'utf8');
    const result = await invoke(['save', '../bad.md', '--name', 'bad']);
    expect(result.exitCode).toBe(1);
    expect(await store.exists('bad')).toBe(false);
  });

  it('lists by tag, shows raw Markdown, removes, and reports missing names', async () => {
    await invoke(['new', 'weekly', '--tags', 'work,weekly']);
    await invoke(['new', 'personal', '--tags', 'home']);

    const listed = await invoke(['list', '--tag', 'WORK', '--json']);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      kind: 'template_list',
      tag: 'work',
      items: [{ name: 'weekly' }],
    });

    const shown = await invoke(['show', 'weekly']);
    expect(shown.stdout).toContain('# {{ title | text }}');
    expect(shown.stdout).toContain('KEY');

    const removed = await invoke(['remove', 'weekly', '--json']);
    expect(JSON.parse(removed.stdout)).toMatchObject({
      kind: 'template_remove',
      name: 'weekly',
      removed: true,
    });
    expect(await store.exists('weekly')).toBe(false);

    const missing = await invoke(['show', 'missing']);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('Available: personal');
    expect((await invoke(['remove', 'missing'])).exitCode).toBe(1);
  });

  it('new collision fails unless force is supplied', async () => {
    expect((await invoke(['new', 'weekly'])).exitCode).toBe(0);
    expect((await invoke(['new', 'weekly'])).exitCode).toBe(1);
    expect((await invoke(['new', 'weekly', '--force'])).exitCode).toBe(0);
    expect(await readFile(store.pathFor('weekly'), 'utf8')).toContain('name: weekly');
  });
});
