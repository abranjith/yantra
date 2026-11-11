// @no-llm
/**
 * The app's `ui.theme` and `ui.surfaces` preferences (FEAT-065 TASK-009).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  KNOWN_PREFERENCE_KEYS,
  defaultProfile,
  flattenProfile,
  loadProfile,
  validatePreference,
} from '../../src/profile/profile-file.js';

describe('defaults', () => {
  it('are system theme and glass surfaces when the keys are absent', () => {
    expect(defaultProfile().ui).toEqual({ theme: 'system', surfaces: 'glass' });
  });

  it('flatten into ui.theme and ui.surfaces', () => {
    const flat = flattenProfile(defaultProfile());
    expect(flat.get('ui.theme')).toBe('system');
    expect(flat.get('ui.surfaces')).toBe('glass');
  });
});

describe('known keys', () => {
  it('include ui.theme and ui.surfaces, and no ui.density', () => {
    expect(KNOWN_PREFERENCE_KEYS).toContain('ui.theme');
    expect(KNOWN_PREFERENCE_KEYS).toContain('ui.surfaces');
    expect(KNOWN_PREFERENCE_KEYS).not.toContain('ui.density');
  });

  it('are exactly what flattenProfile emits', () => {
    expect([...flattenProfile(defaultProfile()).keys()].sort()).toEqual(
      [...KNOWN_PREFERENCE_KEYS].sort(),
    );
  });
});

describe('validatePreference', () => {
  it.each([
    ['ui.theme', 'system'],
    ['ui.theme', 'light'],
    ['ui.theme', 'dark'],
    ['ui.surfaces', 'glass'],
    ['ui.surfaces', 'solid'],
  ])('accepts %s = %s', (key, value) => {
    const result = validatePreference(key, value);
    expect(result.isOk && result.value).toBe(value);
  });

  it('rejects an invalid theme and lists the valid values', () => {
    const result = validatePreference('ui.theme', 'neon');
    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.error).toContain('ui.theme');
      for (const value of ['system', 'light', 'dark']) expect(result.error).toContain(value);
    }
  });

  it('rejects invalid surfaces and lists the valid values', () => {
    const result = validatePreference('ui.surfaces', 'frosted');
    expect(!result.isOk && result.error).toMatch(/glass.*solid/u);
  });

  it('treats ui.density as unknown', () => {
    const result = validatePreference('ui.density', 'compact');
    expect(!result.isOk && result.error).toContain('unknown preference key "ui.density"');
  });
});

describe('profile.yaml', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yantra-ui-prefs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a stored theme and fills the missing surfaces default', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(path, 'ui:\n  theme: dark\n');
    const loaded = await loadProfile(path);
    expect(loaded.isOk && loaded.value.ui).toEqual({ theme: 'dark', surfaces: 'glass' });
  });

  it('refuses an invalid stored value with the field named', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(path, 'ui:\n  surfaces: frosted\n');
    const loaded = await loadProfile(path);
    expect(!loaded.isOk && loaded.error).toContain('ui.surfaces');
  });

  it('drops an unknown ui key such as density, like every other nested block', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(path, 'ui:\n  density: compact\n');
    const loaded = await loadProfile(path);
    expect(loaded.isOk && loaded.value.ui).toEqual({ theme: 'system', surfaces: 'glass' });
  });
});
