/**
 * Resolvability validation for a custom browser path.
 *
 * This is not a compatibility probe, and the tests hold it to that: every case
 * is decided from the filesystem alone. Each reason also has to read
 * differently — two failures that share wording send the user looking for the
 * wrong thing.
 */

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateSelectablePath } from '../../src/browser/selection-validation.js';

describe('@no-llm selectable browser path validation', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-selection-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  async function executable(name = 'chrome'): Promise<string> {
    const path = join(root, name);
    await writeFile(path, '#!/bin/sh\n');
    await chmod(path, 0o755);
    return path;
  }

  it('accepts an absolute path to a readable executable file', async () => {
    const path = await executable();
    await expect(validateSelectablePath(path)).resolves.toEqual({
      status: 'valid',
      executablePath: path,
    });
  });

  it('trims surrounding whitespace before validating', async () => {
    const path = await executable();
    const result = await validateSelectablePath(`  ${path}  `);
    expect(result).toEqual({ status: 'valid', executablePath: path });
  });

  it('rejects an empty path', async () => {
    const result = await validateSelectablePath('   ');
    expect(result).toMatchObject({ status: 'invalid', reason: 'empty' });
  });

  it('rejects a relative path', async () => {
    const result = await validateSelectablePath('chrome/chrome');
    expect(result).toMatchObject({ status: 'invalid', reason: 'not-absolute' });
  });

  it('rejects a path that does not exist', async () => {
    const result = await validateSelectablePath(join(root, 'absent'));
    expect(result).toMatchObject({ status: 'invalid', reason: 'missing' });
  });

  it('rejects a directory and says where the executable actually lives', async () => {
    const directory = join(root, 'Chrome.app');
    await mkdir(directory, { recursive: true });
    const result = await validateSelectablePath(directory);
    expect(result).toMatchObject({ status: 'invalid', reason: 'not-a-file' });
  });

  // A distribution shipping `/usr/bin/google-chrome` as a link to the real
  // binary is an ordinary, valid selection.
  it('follows a symlink to a real executable', async () => {
    const target = await executable('real-chrome');
    const link = join(root, 'linked-chrome');
    try {
      await symlink(target, link);
    } catch {
      return; // Windows without developer mode refuses symlink creation.
    }
    await expect(validateSelectablePath(link)).resolves.toMatchObject({ status: 'valid' });
  });

  it('reports a dangling symlink as missing rather than unreadable', async () => {
    const link = join(root, 'dangling');
    try {
      await symlink(join(root, 'never-existed'), link);
    } catch {
      return;
    }
    const result = await validateSelectablePath(link);
    expect(result).toMatchObject({ status: 'invalid', reason: 'missing' });
  });

  it('rejects a file with no execute permission on POSIX hosts', async () => {
    // The execute bit is a POSIX concept; asking for it on Windows would refuse
    // every real chrome.exe, so the injected platform drives the case.
    const path = join(root, 'not-executable');
    await writeFile(path, 'x');
    const result = await validateSelectablePath(path, {
      platform: 'linux',
      access: (target, mode) => {
        // R_OK passes, X_OK fails — the state a 0644 binary is actually in.
        if (mode === 1) return Promise.reject(new Error('EACCES'));
        return Promise.resolve();
      },
    });
    expect(result).toMatchObject({ status: 'invalid', reason: 'not-executable' });
  });

  it('does not require an execute bit on Windows', async () => {
    const path = join(root, 'chrome.exe');
    await writeFile(path, 'MZ');
    const result = await validateSelectablePath(path, {
      platform: 'win32',
      access: (_target, mode) =>
        mode === 1 ? Promise.reject(new Error('EACCES')) : Promise.resolve(),
    });
    expect(result).toMatchObject({ status: 'valid' });
  });

  it('reports an unreadable file distinctly from a missing one', async () => {
    const path = join(root, 'unreadable');
    await writeFile(path, 'x');
    const result = await validateSelectablePath(path, {
      access: () => Promise.reject(new Error('EACCES: permission denied')),
    });
    expect(result).toMatchObject({ status: 'invalid', reason: 'unreadable' });
  });

  it('gives every reason its own message', async () => {
    const directory = join(root, 'dir');
    await mkdir(directory, { recursive: true });
    const unreadable = join(root, 'locked');
    await writeFile(unreadable, 'x');

    const messages = [
      await validateSelectablePath('   '),
      await validateSelectablePath('relative/chrome'),
      await validateSelectablePath(join(root, 'absent')),
      await validateSelectablePath(directory),
      await validateSelectablePath(unreadable, {
        access: () => Promise.reject(new Error('EACCES')),
      }),
    ].map((result) => (result.status === 'invalid' ? result.detail : 'valid'));

    expect(new Set(messages).size).toBe(messages.length);
  });
});
