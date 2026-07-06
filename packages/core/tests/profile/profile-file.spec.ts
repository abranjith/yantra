import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultProfile,
  flattenProfile,
  loadProfile,
  saveProfile,
  validatePreference,
} from '../../src/profile/profile-file.js';

describe('@no-llm profile-file schema', () => {
  it('fills every default from an empty object', () => {
    const profile = defaultProfile();
    expect(profile.defaults).toEqual({
      search_provider: 'auto',
      detail: 'standard',
      length: 'medium',
    });
    expect(profile.locale).toEqual({ region: null, units: 'metric' });
    expect(profile.personalization).toEqual({
      enabled: true,
      interests: [],
      favorite_retailers: [],
    });
  });

  it('flattens into the dotted preference key space', () => {
    const flat = flattenProfile(defaultProfile());
    expect(flat.get('defaults.detail')).toBe('standard');
    expect(flat.get('locale.units')).toBe('metric');
    expect(flat.get('personalization.enabled')).toBe(true);
    expect(flat.get('personalization.favorite_retailers')).toEqual([]);
  });
});

describe('@no-llm profile-file load/save', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yantra-profile-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the default profile when the file is absent', async () => {
    const result = await loadProfile(join(dir, 'nope.yaml'));
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value).toEqual(defaultProfile());
  });

  it('round-trips a saved profile', async () => {
    const path = join(dir, 'profile.yaml');
    const profile = defaultProfile();
    const edited = {
      ...profile,
      defaults: { ...profile.defaults, detail: 'full' as const },
      personalization: { ...profile.personalization, favorite_retailers: ['amazon', 'bestbuy'] },
    };
    await saveProfile(edited, path);

    const reloaded = await loadProfile(path);
    expect(reloaded.isOk).toBe(true);
    if (reloaded.isOk) {
      expect(reloaded.value.defaults.detail).toBe('full');
      expect(reloaded.value.personalization.favorite_retailers).toEqual(['amazon', 'bestbuy']);
    }
  });

  it('returns an error with field context for an invalid profile', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(path, 'defaults:\n  detail: gigantic\n', 'utf8');
    const result = await loadProfile(path);
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error).toContain('defaults.detail');
  });

  it('rejects unknown top-level keys (strict schema)', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(path, 'surprise: true\n', 'utf8');
    const result = await loadProfile(path);
    expect(result.isOk).toBe(false);
  });

  it('writes an owner-editable file with a comment header', async () => {
    const path = join(dir, 'profile.yaml');
    await saveProfile(defaultProfile(), path);
    const contents = await readFile(path, 'utf8');
    expect(contents).toContain('# yantra profile');
    expect(contents).toContain('detail: standard');
  });
});

describe('@no-llm validatePreference', () => {
  it('rejects unknown keys with a hint listing valid keys', () => {
    const result = validatePreference('defaults.nonsense', 'x');
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error).toContain('defaults.detail');
  });

  it('validates an enum value', () => {
    expect(validatePreference('defaults.detail', 'full').isOk).toBe(true);
    expect(validatePreference('defaults.detail', 'gigantic').isOk).toBe(false);
  });

  it('coerces a comma-separated list for array keys', () => {
    const result = validatePreference(
      'personalization.favorite_retailers',
      'amazon, bestbuy , target',
    );
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value).toEqual(['amazon', 'bestbuy', 'target']);
  });

  it('coerces true/false for the boolean key', () => {
    const on = validatePreference('personalization.enabled', 'false');
    expect(on.isOk).toBe(true);
    if (on.isOk) expect(on.value).toBe(false);
    expect(validatePreference('personalization.enabled', 'maybe').isOk).toBe(false);
  });

  it('coerces the literal "null" to null for locale.region', () => {
    const result = validatePreference('locale.region', 'null');
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value).toBeNull();
  });
});
