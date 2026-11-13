// @no-llm
/**
 * Embedding the app into the CLI (FEAT-065 TASK-012): the embed script, and
 * the host reading its build ID from the embedded copy.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HostStartError } from '../../../src/ui/host/errors.js';
import { readBuildId } from '../../../src/ui/host/host-runtime.js';

import { cleanupTempDirs, makeTempDir, makeWebBuild } from './support.js';

const SCRIPT = resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'embed-web.mjs');

function embed(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

afterEach(() => {
  cleanupTempDirs();
});

describe('embed-web.mjs', () => {
  it('copies the app build into dist/web', () => {
    const from = makeWebBuild();
    const to = join(makeTempDir(), 'web');
    const result = embed('--from', from, '--to', to);
    expect(result.status).toBe(0);
    expect(readFileSync(join(to, 'index.html'), 'utf8')).toBe(
      readFileSync(join(from, 'index.html'), 'utf8'),
    );
    expect(existsSync(join(to, 'assets', 'main-AbC123xy.js'))).toBe(true);
    expect(result.stdout).toContain('Embedded the Yantra app (build build-test)');
  });

  it('clears the old copy first, so no stale asset survives', () => {
    const from = makeWebBuild();
    const to = join(makeTempDir(), 'web');
    mkdirSync(join(to, 'assets'), { recursive: true });
    writeFileSync(join(to, 'assets', 'old-0000.js'), 'stale');
    expect(embed('--from', from, '--to', to).status).toBe(0);
    expect(existsSync(join(to, 'assets', 'old-0000.js'))).toBe(false);
  });

  it('fails clearly when the app build is absent', () => {
    const result = embed(
      '--from',
      join(makeTempDir(), 'missing-dist'),
      '--to',
      join(makeTempDir(), 'web'),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('The Yantra app build is missing index.html');
    expect(result.stderr).toContain('pnpm build');
  });

  it('fails when build-id.json is missing', () => {
    const from = makeTempDir();
    writeFileSync(join(from, 'index.html'), '<!doctype html>');
    const result = embed('--from', from, '--to', join(makeTempDir(), 'web'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing build-id.json');
  });

  it('refuses an unknown argument', () => {
    const result = embed('--into', 'x');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown argument --into');
  });
});

describe('readBuildId', () => {
  it('reads the build ID from the embedded copy', async () => {
    const to = join(makeTempDir(), 'web');
    embed('--from', makeWebBuild(), '--to', to);
    expect(await readBuildId(to)).toBe('build-test');
  });

  it('fails with assets_missing when build-id.json is absent', async () => {
    const error = await readBuildId(makeTempDir()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostStartError);
    expect(error).toMatchObject({ code: 'assets_missing' });
  });
});

describe.skipIf(
  !existsSync(resolve(import.meta.dirname, '..', '..', '..', 'dist', 'web', 'index.html')),
)('the built CLI', () => {
  it('embeds a web build whose build-id.json equals its meta tag', () => {
    const web = resolve(import.meta.dirname, '..', '..', '..', 'dist', 'web');
    const { build_id: id } = JSON.parse(readFileSync(join(web, 'build-id.json'), 'utf8')) as {
      build_id: string;
    };
    expect(readFileSync(join(web, 'index.html'), 'utf8')).toContain(
      `<meta name="yantra-build-id" content="${id}">`,
    );
  });
});
