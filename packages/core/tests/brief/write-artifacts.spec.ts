import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalBrief } from '@yantra/test-helpers';
import { describe, expect, it } from 'vitest';

import { briefToHtml } from '../../src/brief/to-html.js';
import { briefToMarkdown } from '../../src/brief/to-markdown.js';
import { writeBriefArtifacts } from '../../src/brief/write-artifacts.js';

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

describe('@no-llm writeBriefArtifacts', () => {
  it('writes brief.json, brief.md, and brief.html with the expected content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yantra-brief-'));

    const result = await writeBriefArtifacts(dir, canonicalBrief);

    expect(result.isOk).toBe(true);
    if (!result.isOk) {
      return;
    }
    const json = JSON.parse(await readFile(result.value.jsonPath, 'utf8')) as { brief_id: string };
    expect(json.brief_id).toBe(canonicalBrief.brief_id);
    expect(await readFile(result.value.mdPath, 'utf8')).toBe(
      `${briefToMarkdown(canonicalBrief)}\n`,
    );
    expect(await readFile(result.value.htmlPath, 'utf8')).toBe(briefToHtml(canonicalBrief));

    await rm(dir, { recursive: true, force: true });
  });

  it('cleans up .tmp files and writes no finals when a staged write fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yantra-brief-'));
    // Occupy the html .tmp path with a directory so its writeFile rejects.
    await mkdir(join(dir, 'brief.html.tmp'));

    const result = await writeBriefArtifacts(dir, canonicalBrief);

    expect(result.isOk).toBe(false);
    // No final artifacts became visible (renames never ran).
    expect(await exists(join(dir, 'brief.json'))).toBe(false);
    expect(await exists(join(dir, 'brief.md'))).toBe(false);
    expect(await exists(join(dir, 'brief.html'))).toBe(false);
    // The writer's own staged tmp files were cleaned up.
    expect(await exists(join(dir, 'brief.json.tmp'))).toBe(false);
    expect(await exists(join(dir, 'brief.md.tmp'))).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });
});
