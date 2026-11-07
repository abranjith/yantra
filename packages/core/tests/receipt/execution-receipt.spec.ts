import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  contentIdentity,
  writeExecutionReceipt,
  type ExecutionReceiptDraft,
} from '../../src/receipt/execution-receipt.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const value = await mkdtemp(join(tmpdir(), 'yantra-receipt-'));
  roots.push(value);
  return value;
}
const draft: ExecutionReceiptDraft = {
  schema_version: 1,
  yantra_version: '0.0.1 (yantra cli)',
  invoked_by: 'terminal',
  invocation_id: null,
  command: ['research'],
  cwd: 'C:/fixture',
  settings: [{ key: 'depth', value: 2, source: { kind: 'default' } }],
  content: [],
  browser: null,
};
describe('@no-llm immutable execution receipts', () => {
  it('exclusively publishes sequence zero and retains its original bytes', async () => {
    const dir = await root();
    const first = await writeExecutionReceipt(dir, draft);
    const original = await readFile(first.path, 'utf8');
    await expect(writeExecutionReceipt(dir, { ...draft, settings: [] })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(first.path, 'utf8')).toBe(original);
    expect(await readdir(dir)).toEqual(['execution-receipt.json']);
  });
  it('gives concurrent resumes different consecutive names without changing the original', async () => {
    const dir = await root();
    const first = await writeExecutionReceipt(dir, draft);
    const original = await readFile(first.path, 'utf8');
    const resumed = await Promise.all(
      [1, 2, 3, 4].map(() => writeExecutionReceipt(dir, draft, { resume: true })),
    );
    expect(resumed.map((v) => v.receipt.sequence).sort()).toEqual([1, 2, 3, 4]);
    expect(await readFile(first.path, 'utf8')).toBe(original);
    expect((await readdir(dir)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('publishes owner-only permissions', async () => {
    const written = await writeExecutionReceipt(await root(), draft);
    expect((await stat(written.path)).mode & 0o777).toBe(0o600);
  });
  it('hashes exact streamed bytes and detects a later edit', async () => {
    const path = join(await root(), 'workflow.yaml');
    const bytes = Buffer.alloc(1024 * 1024 + 7, 0xf3);
    await writeFile(path, bytes);
    const first = await contentIdentity('workflow', path);
    expect(first.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    await writeFile(path, 'edited');
    expect((await contentIdentity('workflow', path)).sha256).not.toBe(first.sha256);
  });
  it('rejects relative content paths', async () => {
    await expect(contentIdentity('template', 'relative.md')).rejects.toThrow('absolute');
  });
});
