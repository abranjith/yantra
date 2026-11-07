import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalBrief } from '@yantra/test-helpers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { briefToHtml } from '../../src/brief/to-html.js';
import { briefToMarkdown } from '../../src/brief/to-markdown.js';
import { writeBriefArtifacts } from '../../src/brief/write-artifacts.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof fs>('node:fs/promises');

const exists = async (path: string): Promise<boolean> => {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
};

describe('@no-llm writeBriefArtifacts', () => {
  beforeEach(() => {
    vi.mocked(fs.open).mockImplementation(actual.open);
  });
  it('writes brief.json, brief.md, and brief.html with the expected content', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'yantra-brief-'));

    const result = await writeBriefArtifacts(dir, canonicalBrief);

    expect(result.isOk).toBe(true);
    if (!result.isOk) {
      return;
    }
    const json = JSON.parse(await fs.readFile(result.value.jsonPath, 'utf8')) as {
      brief_id: string;
    };
    expect(json.brief_id).toBe(canonicalBrief.brief_id);
    expect(await fs.readFile(result.value.mdPath, 'utf8')).toBe(
      `${briefToMarkdown(canonicalBrief)}\n`,
    );
    expect(await fs.readFile(result.value.htmlPath, 'utf8')).toBe(briefToHtml(canonicalBrief));

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('cleans up .tmp files and writes no finals when a staged write fails', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'yantra-brief-'));
    // The temporary name is unique now: fail the actual external open boundary.
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (String(args[0]).includes('brief.html.'))
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return await actual.open(...args);
    });

    const result = await writeBriefArtifacts(dir, canonicalBrief);

    expect(result.isOk).toBe(false);
    // No final artifacts became visible (renames never ran).
    expect(await exists(join(dir, 'brief.json'))).toBe(false);
    expect(await exists(join(dir, 'brief.md'))).toBe(false);
    expect(await exists(join(dir, 'brief.html'))).toBe(false);
    // The writer's own staged tmp files were cleaned up.
    expect(await fs.readdir(dir)).toEqual([]);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
