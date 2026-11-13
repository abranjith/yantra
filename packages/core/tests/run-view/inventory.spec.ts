// @no-llm
/**
 * The public run inventory (FEAT-066 TASK-004): a depth-2, registry-classified
 * walk that omits denied files, never follows links, and stops at its cap.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listRunArtifacts } from '../../src/run-view/inventory.js';

import { buildRunDir } from './fixtures/build-run-dir.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'yantra-inventory-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('listRunArtifacts', () => {
  it('lists public files with their entry, viewer, size and cap flag, sorted', async () => {
    const runDir = await buildRunDir(root, {
      runId: 'r',
      files: {
        'report.md': 'x'.repeat(10),
        'agent/session.jsonl': '{}\n',
        'screenshots/1-abcdef123456.png': 'png',
        'captures/cap-01J.txt': 'text',
        'brief.json': '{}',
      },
    });

    const { items, truncated } = await listRunArtifacts(runDir);

    expect(truncated).toBe(false);
    expect(items.map((item) => item.path)).toEqual([
      'agent/session.jsonl',
      'brief.json',
      'captures/cap-01J.txt',
      'manifest.json',
      'report.md',
      'screenshots/1-abcdef123456.png',
    ]);
    expect(items.find((item) => item.path === 'report.md')).toMatchObject({
      entry_id: 'report.md',
      exposure: 'view',
      viewer: 'markdown',
      bytes: 10,
      over_inline_cap: false,
    });
    expect(items.find((item) => item.path === 'brief.json')?.exposure).toBe('typed');
    expect(Date.parse(items[0]!.modified_at)).not.toBeNaN();
  });

  it('omits denied files entirely', async () => {
    const runDir = await buildRunDir(root, {
      runId: 'r',
      files: {
        'lease.json': '{}',
        'reconcile.lock': '',
        'decisions/x.json': '{}',
        'brief.json.tmp': '{}',
        'screenshots/evil.png': 'png',
        'plan.json': '{}',
        'captures/cap-1.json': '{}',
      },
    });

    const paths = (await listRunArtifacts(runDir)).items.map((item) => item.path);

    expect(paths).toEqual(['manifest.json']);
  });

  it('flags a file over its inline cap', async () => {
    const runDir = await buildRunDir(root, {
      runId: 'r',
      files: { 'report.md': 'x'.repeat(512 * 1024 + 1) },
    });
    const item = (await listRunArtifacts(runDir)).items.find((entry) => entry.path === 'report.md');
    expect(item?.over_inline_cap).toBe(true);
  });

  it('walks only one directory level deep', async () => {
    const runDir = await buildRunDir(root, {
      runId: 'r',
      files: { 'agent/deep/x.jsonl': '{}\n', 'agent/top.jsonl': '{}\n' },
    });
    const paths = (await listRunArtifacts(runDir)).items.map((item) => item.path);
    expect(paths).toContain('agent/top.jsonl');
    expect(paths.some((path) => path.includes('deep'))).toBe(false);
  });

  it('never follows a link (a junction on Windows) out of the run', async () => {
    const runDir = await buildRunDir(root, { runId: 'r' });
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'leak.jsonl'), '{}\n');
    await symlink(outside, join(runDir, 'agent'), 'junction');

    const paths = (await listRunArtifacts(runDir)).items.map((item) => item.path);

    expect(paths).toEqual(['manifest.json']);
  });

  it('stops at the cap and says so', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`agent/s${String(i).padStart(2, '0')}.jsonl`] = '{}\n';
    const runDir = await buildRunDir(root, { runId: 'r', files });

    const { items, truncated } = await listRunArtifacts(runDir, { cap: 5 });

    expect(items).toHaveLength(5);
    expect(truncated).toBe(true);
  });

  it('is empty for a directory that does not exist', async () => {
    expect(await listRunArtifacts(join(root, 'missing'))).toEqual({ items: [], truncated: false });
  });
});
