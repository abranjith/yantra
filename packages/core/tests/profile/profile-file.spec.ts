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
    expect(profile.locale).toEqual({ city: null, region: null, units: 'metric' });
    expect(profile.context).toEqual({ location: true });
    expect(profile.personalization).toEqual({
      enabled: true,
      interests: [],
      favorite_retailers: [],
    });
    expect(profile.agent).toEqual({
      provider: null,
      model: null,
      thinking: null,
      max_duration: '15m',
      max_tokens: 2_000_000,
      tool_timeout: '3m',
      tool_retries: 3,
      confirm_timeout: '3m',
    });
  });

  it('flattens into the dotted preference key space', () => {
    const flat = flattenProfile(defaultProfile());
    expect(flat.get('defaults.detail')).toBe('standard');
    expect(flat.get('locale.units')).toBe('metric');
    expect(flat.get('locale.city')).toBeNull();
    expect(flat.get('context.location')).toBe(true);
    expect(flat.get('personalization.enabled')).toBe(true);
    expect(flat.get('personalization.favorite_retailers')).toEqual([]);
    expect(Object.fromEntries(flat)).toMatchObject({
      'agent.provider': null,
      'agent.model': null,
      'agent.thinking': null,
      'agent.max_duration': '15m',
      'agent.max_tokens': 2_000_000,
      'agent.tool_timeout': '3m',
      'agent.tool_retries': 3,
      'agent.confirm_timeout': '3m',
    });
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
      agent: {
        ...profile.agent,
        provider: 'ollama',
        model: 'llama3.1:8b',
        max_duration: '20m',
        tool_retries: 5,
      },
    };
    await saveProfile(edited, path);

    const reloaded = await loadProfile(path);
    expect(reloaded.isOk).toBe(true);
    if (reloaded.isOk) {
      expect(reloaded.value.defaults.detail).toBe('full');
      expect(reloaded.value.personalization.favorite_retailers).toEqual(['amazon', 'bestbuy']);
      expect(reloaded.value.agent).toMatchObject({
        provider: 'ollama',
        model: 'llama3.1:8b',
        max_duration: '20m',
        tool_retries: 5,
      });
    }
  });

  it('returns an error with field context for an invalid profile', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(path, 'defaults:\n  detail: gigantic\n', 'utf8');
    const result = await loadProfile(path);
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error).toContain('defaults.detail');
  });

  it('names an invalid agent duration field', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(path, 'agent:\n  max_duration: nope\n', 'utf8');
    const result = await loadProfile(path);
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error).toContain('agent.max_duration');
  });

  it('rejects unknown top-level keys (strict schema)', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(path, 'surprise: true\n', 'utf8');
    const result = await loadProfile(path);
    expect(result.isOk).toBe(false);
  });

  it('accepts the context block and locale.city', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(path, 'locale:\n  city: Naperville, IL\ncontext:\n  location: false\n', 'utf8');
    const result = await loadProfile(path);
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.locale.city).toBe('Naperville, IL');
      expect(result.value.context.location).toBe(false);
    }
  });

  it('rejects an empty locale.city', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(path, 'locale:\n  city: ""\n', 'utf8');
    const result = await loadProfile(path);
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error).toContain('locale.city');
  });

  it('still rejects a genuinely unknown top-level key alongside the new blocks', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(path, 'context:\n  location: true\nsurprise: true\n', 'utf8');
    const result = await loadProfile(path);
    expect(result.isOk).toBe(false);
  });

  it('rejects a non-boolean context.location', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(path, 'context:\n  location: sometimes\n', 'utf8');
    const result = await loadProfile(path);
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error).toContain('context.location');
  });

  it('loads a profile written before the context block with the grant defaulted', async () => {
    // Byte-for-byte a pre-change profile.yaml: no `context` block, no locale.city.
    const path = join(dir, 'profile.yaml');
    await writeFile(
      path,
      [
        '# yantra profile — your personal defaults (edit freely)',
        'defaults:',
        '  search_provider: auto',
        '  detail: standard',
        '  length: medium',
        'locale:',
        '  region: null',
        '  units: metric',
        'personalization:',
        '  enabled: true',
        '  interests: []',
        '  favorite_retailers: []',
        '',
      ].join('\n'),
      'utf8',
    );
    const result = await loadProfile(path);
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.context).toEqual({ location: true });
      expect(result.value.locale.city).toBeNull();
    }
  });

  it('round-trips the context grant and city through save/load', async () => {
    const path = join(dir, 'profile.yaml');
    const profile = defaultProfile();
    await saveProfile(
      {
        ...profile,
        locale: { ...profile.locale, city: 'Naperville, IL' },
        context: { location: false },
      },
      path,
    );
    const reloaded = await loadProfile(path);
    expect(reloaded.isOk).toBe(true);
    if (reloaded.isOk) {
      expect(reloaded.value.locale.city).toBe('Naperville, IL');
      expect(reloaded.value.context.location).toBe(false);
    }
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

  it('accepts and coerces the context.location grant', () => {
    const off = validatePreference('context.location', 'false');
    expect(off.isOk).toBe(true);
    if (off.isOk) expect(off.value).toBe(false);
    const on = validatePreference('context.location', 'true');
    expect(on.isOk).toBe(true);
    if (on.isOk) expect(on.value).toBe(true);
    expect(validatePreference('context.location', 'maybe').isOk).toBe(false);
  });

  it('accepts locale.city, trimming it, and rejects a blank value', () => {
    const set = validatePreference('locale.city', '  Naperville, IL  ');
    expect(set.isOk).toBe(true);
    if (set.isOk) expect(set.value).toBe('Naperville, IL');
    expect(validatePreference('locale.city', '   ').isOk).toBe(false);
    const cleared = validatePreference('locale.city', 'null');
    expect(cleared.isOk).toBe(true);
    if (cleared.isOk) expect(cleared.value).toBeNull();
  });

  it('validates agent duration and integer preferences at write time', () => {
    expect(validatePreference('agent.max_duration', '20m').isOk).toBe(true);
    expect(validatePreference('agent.max_duration', 'nope').isOk).toBe(false);
    expect(validatePreference('agent.max_tokens', '2000000').isOk).toBe(true);
    expect(validatePreference('agent.max_tokens', '0').isOk).toBe(false);
    expect(validatePreference('agent.tool_retries', '0').isOk).toBe(true);
    expect(validatePreference('agent.tool_retries', '-1').isOk).toBe(false);
  });
});
