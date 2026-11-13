// @no-llm
/**
 * The public-artifact gate (FEAT-066 TASK-001): run-id validation before any
 * filesystem call, registry classification, realpath containment and
 * regular-file checks.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPathCache, runsRoot } from '../../src/browser/paths.js';
import {
  NODE_ARTIFACT_GATE_FS,
  resolvePublicArtifact,
  type ArtifactGateFs,
} from '../../src/run-view/artifact-gate.js';
import { ArtifactAccessError } from '../../src/run-view/errors.js';

const RUN_ID = '20260511T091234Z-bank-statement-a7b3';

let home: string;
let previousHome: string | undefined;
let runDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yantra-gate-'));
  previousHome = process.env.YANTRA_HOME;
  process.env.YANTRA_HOME = home;
  resetPathCache();
  runDir = join(runsRoot(), RUN_ID);
  await mkdir(runDir, { recursive: true });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = previousHome;
  resetPathCache();
  await rm(home, { recursive: true, force: true });
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ArtifactAccessError);
  expect((error as ArtifactAccessError).code).toBe(code);
}

describe('resolvePublicArtifact', () => {
  it('resolves runsRoot under the sandboxed YANTRA_HOME', () => {
    expect(runsRoot().startsWith(home)).toBe(true);
  });

  it('returns the absolute path, entry, size and mtime of a public file', async () => {
    await writeFile(join(runDir, 'brief.md'), '# Brief\n');

    const found = await resolvePublicArtifact(runsRoot(), RUN_ID, 'brief.md');

    expect(found.entry.id).toBe('brief.md');
    expect(found.relPath).toBe('brief.md');
    expect(found.bytes).toBe(8);
    expect(found.mtime).toBeInstanceOf(Date);
    expect(found.absPath.toLowerCase()).toContain('brief.md');
  });

  it('resolves a nested allowed file', async () => {
    await mkdir(join(runDir, 'agent'));
    await writeFile(join(runDir, 'agent', 'session.jsonl'), '{}\n');

    const found = await resolvePublicArtifact(runsRoot(), RUN_ID, 'agent/session.jsonl');

    expect(found.entry.id).toBe('agent-session');
  });

  it.each(['../x', '20260511T091234Z-a/../b', 'not-a-run', '', 'C:'])(
    'refuses run id %j before any filesystem call',
    async (runId) => {
      const fs: ArtifactGateFs = {
        realpath: vi.fn(NODE_ARTIFACT_GATE_FS.realpath),
        stat: vi.fn(NODE_ARTIFACT_GATE_FS.stat),
      };

      await expectCode(
        resolvePublicArtifact(runsRoot(), runId, 'brief.md', { fs }),
        'invalid_run_id',
      );

      expect(fs.realpath).not.toHaveBeenCalled();
      expect(fs.stat).not.toHaveBeenCalled();
    },
  );

  it.each([
    'lease.json',
    'decisions/x.json',
    'brief.json.tmp',
    '../manifest.json',
    '../../outside.txt',
    'a\\b',
    'C:/x',
    '%2e%2e/x',
    'unknown.bin',
  ])('refuses %j as not_public without touching the filesystem', async (path) => {
    await writeFile(join(runDir, 'lease.json'), '{}');
    const fs: ArtifactGateFs = {
      realpath: vi.fn(NODE_ARTIFACT_GATE_FS.realpath),
      stat: vi.fn(NODE_ARTIFACT_GATE_FS.stat),
    };

    await expectCode(resolvePublicArtifact(runsRoot(), RUN_ID, path, { fs }), 'not_public');

    expect(fs.realpath).not.toHaveBeenCalled();
  });

  it('refuses an exposure the caller does not serve', async () => {
    await writeFile(join(runDir, 'brief.json'), '{}');

    await expectCode(
      resolvePublicArtifact(runsRoot(), RUN_ID, 'brief.json', { exposures: ['view', 'download'] }),
      'not_public',
    );
  });

  it('is not_found for a missing file or a missing run', async () => {
    await expectCode(resolvePublicArtifact(runsRoot(), RUN_ID, 'report.md'), 'not_found');
    await expectCode(
      resolvePublicArtifact(runsRoot(), '20260101T000000Z-missing', 'report.md'),
      'not_found',
    );
  });

  it('is not_found for a directory that matches an allowed name', async () => {
    await mkdir(join(runDir, 'report.md'));

    await expectCode(resolvePublicArtifact(runsRoot(), RUN_ID, 'report.md'), 'not_found');
  });

  it('is outside_run when a link (junction on Windows) leads out of the run', async () => {
    const outside = join(home, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.jsonl'), '{"leak":true}\n');
    await symlink(outside, join(runDir, 'agent'), 'junction');

    await expectCode(
      resolvePublicArtifact(runsRoot(), RUN_ID, 'agent/secret.jsonl'),
      'outside_run',
    );
  });

  it('refuses a link inside the run that lands on another entry', async () => {
    await mkdir(join(runDir, 'decisions'));
    await writeFile(join(runDir, 'decisions', 'x.jsonl'), '{}\n');
    await symlink(join(runDir, 'decisions'), join(runDir, 'agent'), 'junction');

    await expectCode(resolvePublicArtifact(runsRoot(), RUN_ID, 'agent/x.jsonl'), 'not_public');
  });

  it('is too_large over the inline cap only when the caller requires inline', async () => {
    await writeFile(join(runDir, 'report.md'), 'x'.repeat(512 * 1024 + 1));

    await expectCode(
      resolvePublicArtifact(runsRoot(), RUN_ID, 'report.md', { requireInline: true }),
      'too_large',
    );
    const found = await resolvePublicArtifact(runsRoot(), RUN_ID, 'report.md');
    expect(found.bytes).toBe(512 * 1024 + 1);
  });

  it('never applies an inline cap to a windowed JSONL entry', async () => {
    await writeFile(join(runDir, 'events.jsonl'), 'x'.repeat(1024));

    const found = await resolvePublicArtifact(runsRoot(), RUN_ID, 'events.jsonl', {
      requireInline: true,
    });

    expect(found.entry.inline_cap_bytes).toBeNull();
  });

  it('carries the entry id but never file content in the error', async () => {
    const error = await resolvePublicArtifact(runsRoot(), RUN_ID, 'report.md').catch(
      (caught: unknown) => caught as ArtifactAccessError,
    );

    expect(error.entryId).toBe('report.md');
    expect(error.message).toBe('Run artifact refused: not_found (report.md).');
  });
});
