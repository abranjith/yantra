import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { FileTemplateStore, parseTemplate, templateBody } from '@yantra/core';
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
    const raw = await store.load('weekly');
    expect(raw).toContain('guidance: Write for a busy reader');
    expect(raw).toContain('<!-- guidance: Lead with the main result');
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

  it('lint surfaces truncated human guidance and lossless JSON guidance', async () => {
    const documentGuidance =
      'Use British English for a time-poor CFO and never speculate beyond collected sources.';
    const slotGuidance =
      'Lead with the headline revenue number, then explain the primary driver in one sentence.';
    await store.save(
      'guided',
      `---
name: guided
guidance: ${documentGuidance}
---
# {{ title | text }}
## Executive Summary
<!-- guidance: ${slotGuidance} -->
{{ summary | markdown }}
`,
    );

    const human = await invoke(['lint', 'guided']);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('GUIDANCE (document):');
    expect(human.stdout).toContain('GUIDANCE');
    expect(human.stdout).toContain(`${[...slotGuidance].slice(0, 31).join('')}…`);
    const titleRow = human.stdout.split('\n').find((line) => line.trimStart().startsWith('title'));
    expect(titleRow).toMatch(/\s-$/u);

    const json = await invoke(['lint', 'guided', '--json']);
    const payload = JSON.parse(json.stdout) as {
      readonly template: { readonly guidance: string | null };
      readonly slots: readonly { readonly key: string; readonly guidance: string | null }[];
    };
    expect(payload.template.guidance).toBe(documentGuidance);
    expect(payload.slots.find((slot) => slot.key === 'summary')?.guidance).toBe(slotGuidance);
    expect(payload.slots.find((slot) => slot.key === 'title')?.guidance).toBeNull();
  });

  it('show carries full guidance in JSON and prints the document note for humans', async () => {
    await store.save(
      'guided-show',
      '---\n' +
        'name: guided-show\n' +
        'guidance: Address the board directly.\n' +
        '---\n' +
        '# Report\n' +
        '<!-- guidance: State the decision first. -->\n' +
        '{{ body }}\n',
    );
    const human = await invoke(['show', 'guided-show']);
    expect(human.stdout).toContain('GUIDANCE (document): Address the board directly.');
    const json = JSON.parse((await invoke(['show', 'guided-show', '--json'])).stdout) as {
      readonly template: { readonly guidance: string | null };
      readonly slots: readonly { readonly guidance: string | null }[];
    };
    expect(json.template.guidance).toBe('Address the board directly.');
    expect(json.slots[0]?.guidance).toBe('State the decision first.');
  });

  it('keeps the original four-column table and omits the document line without guidance', async () => {
    await store.save('plain', '# Report\n{{ body }}\n');
    const result = await invoke(['lint', 'plain']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('GUIDANCE');
    expect(result.stdout.split('\n')[0]).toMatch(/^KEY\s+KIND\s+HEADING\s+CONSTRAINTS$/u);
  });

  it('truncates guidance by code point without splitting a surrogate pair', async () => {
    const guidance = `${'a'.repeat(30)}😀bc`;
    await store.save(
      'unicode',
      `# Report\n<!-- guidance: ${guidance} -->\n{{ body }}\n{{ detail }}\n`,
    );
    const result = await invoke(['lint', 'unicode']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${'a'.repeat(30)}😀…`);
    expect(result.stdout).not.toContain('\uFFFD');
    const rows = result.stdout.trimEnd().split('\n');
    const guidanceColumn = rows[0]?.indexOf('GUIDANCE') ?? -1;
    expect(guidanceColumn).toBeGreaterThan(0);
    expect(rows.slice(1).every((row) => row.length > guidanceColumn)).toBe(true);
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

  it('preserves document and per-slot guidance through save and reparse', async () => {
    const guided = `---
name: guided
description: Guided report
guidance: Use British English for the CFO.
---
# {{ title | text }}
<!-- guidance: Lead with the revenue number. -->
{{ summary | markdown }}
`;
    await writeFile(join(root, 'guided.md'), guided, 'utf8');
    const savedResult = await invoke(['save', '../guided.md']);
    expect(savedResult.exitCode).toBe(0);
    const saved = await store.load('guided');
    expect(saved).toContain('guidance: Use British English for the CFO.');
    expect(saved).toContain('<!-- guidance: Lead with the revenue number. -->');
    const parsed = parseTemplate(saved);
    expect(parsed.isOk).toBe(true);
    if (!parsed.isOk) return;
    expect(parsed.value.guidance).toBe('Use British English for the CFO.');
    expect(parsed.value.slots.find((slot) => slot.key === 'summary')?.guidance).toBe(
      'Lead with the revenue number.',
    );
  });

  it('preserves starter guidance when a new template is saved under another name', async () => {
    expect((await invoke(['new', 'starter'])).exitCode).toBe(0);
    expect(
      (await invoke(['save', store.pathFor('starter'), '--name', 'starter-copy'])).exitCode,
    ).toBe(0);
    const copied = await store.load('starter-copy');
    const parsed = parseTemplate(copied);
    expect(parsed.isOk).toBe(true);
    if (!parsed.isOk) return;
    expect(parsed.value.guidance).toBe(
      'Write for a busy reader and stay grounded in the collected sources.',
    );
    expect(parsed.value.slots.find((slot) => slot.key === 'summary')?.guidance).toBe(
      'Lead with the main result and explain why it matters.',
    );
  });

  it('rejects a dangling guidance directive before writing to the library', async () => {
    await writeFile(
      join(root, 'dangling.md'),
      '# Report\n{{ body }}\n<!-- guidance: Orphaned. -->\n',
      'utf8',
    );
    const result = await invoke(['save', '../dangling.md']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/guidance directive is not followed by a slot/i);
    expect(await store.exists('dangling')).toBe(false);
  });

  it('returns no-frontmatter text unchanged from templateBody', () => {
    const text = '<!-- guidance: Preserve this. -->\n{{ body }}\n';
    expect(templateBody(text)).toBe(text);
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
