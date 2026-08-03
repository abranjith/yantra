/**
 * `~/.config/yantra/profile.yaml` — the human-editable personal defaults file.
 *
 * This is the `user` layer of the preference system: durable, inspectable, and
 * owned by the user (local-first, memory §General). It is Zod-validated on load
 * — a malformed profile is an exit-1 validation error with field context, never
 * a silent reset. The machine-managed `learned` signals live in the SQLite
 * `preferences` table; {@link SqlitePreferenceStore} merges the two layers.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { err, ok, type Result } from '@yantra/protocol';
import { z } from 'zod';

import { configDir } from '../browser/paths.js';

/** Returns the path to `profile.yaml`. */
export function profilePath(): string {
  return join(configDir(), 'profile.yaml');
}

const searchProviderSchema = z.enum(['auto', 'google', 'duckduckgo', 'brave', 'tavily']);
const detailSchema = z.enum(['overview', 'standard', 'full']);
const lengthSchema = z.enum(['short', 'medium', 'long']);
const unitsSchema = z.enum(['metric', 'imperial']);
const nullableAgentStringSchema = z.string().trim().min(1).nullable();
const agentDurationSchema = z
  .string()
  .regex(/^[1-9]\d*(?:ms|s|m|h)?$/, 'expected a positive duration such as 15m, 900s, or 900000');

/**
 * The profile.yaml schema. Every block and leaf has a default so a partial (or
 * empty) file still yields a complete, usable profile.
 */
export const profileSchema = z
  .object({
    defaults: z
      .object({
        search_provider: searchProviderSchema.default('auto'),
        detail: detailSchema.default('standard'),
        length: lengthSchema.default('medium'),
      })
      .default({}),
    locale: z
      .object({
        region: z.string().nullable().default(null),
        units: unitsSchema.default('metric'),
      })
      .default({}),
    personalization: z
      .object({
        enabled: z.boolean().default(true),
        interests: z.array(z.string()).default([]),
        favorite_retailers: z.array(z.string()).default([]),
      })
      .default({}),
    agent: z
      .object({
        provider: nullableAgentStringSchema.default(null),
        model: nullableAgentStringSchema.default(null),
        thinking: nullableAgentStringSchema.default(null),
        max_duration: agentDurationSchema.default('15m'),
        max_tokens: z.number().int().positive().default(2_000_000),
        tool_timeout: agentDurationSchema.default('3m'),
        tool_retries: z.number().int().nonnegative().default(3),
        confirm_timeout: agentDurationSchema.default('3m'),
      })
      .default({}),
  })
  .strict();

/** A fully-resolved profile (all defaults applied). */
export type ProfileFile = z.infer<typeof profileSchema>;

/** Returns the built-in default profile (used by `yantra init`). */
export function defaultProfile(): ProfileFile {
  return profileSchema.parse({});
}

/** The set of dotted preference keys the profile schema recognizes. */
export const KNOWN_PREFERENCE_KEYS = [
  'defaults.search_provider',
  'defaults.detail',
  'defaults.length',
  'locale.region',
  'locale.units',
  'personalization.enabled',
  'personalization.interests',
  'personalization.favorite_retailers',
  'agent.provider',
  'agent.model',
  'agent.thinking',
  'agent.max_duration',
  'agent.max_tokens',
  'agent.tool_timeout',
  'agent.tool_retries',
  'agent.confirm_timeout',
] as const;

export type PreferenceKey = (typeof KNOWN_PREFERENCE_KEYS)[number];

/**
 * Loads and validates `profile.yaml`. A missing file yields the default
 * profile; a present-but-invalid file returns an error (the CLI maps it to
 * exit 1 with field context).
 *
 * @param path - Override path (defaults to {@link profilePath}); for tests.
 */
export async function loadProfile(
  path: string = profilePath(),
): Promise<Result<ProfileFile, string>> {
  let raw: unknown;
  try {
    const { parse } = await import('yaml');
    raw = parse(await readFile(path, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return ok(defaultProfile());
    }
    return err(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = profileSchema.safeParse(raw ?? {});
  if (!result.success) {
    return err(
      `invalid ${path}: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'} — ${issue.message}`)
        .join('; ')}`,
    );
  }
  return ok(result.data);
}

/**
 * Atomically writes `profile.yaml` (tmp-then-rename, owner-only perms), matching
 * the workflow/manifest write convention.
 *
 * @param profile - The profile to persist.
 * @param path - Override path (defaults to {@link profilePath}).
 */
export async function saveProfile(
  profile: ProfileFile,
  path: string = profilePath(),
): Promise<void> {
  const { stringify } = await import('yaml');
  const validated = profileSchema.parse(profile);
  const contents = `# yantra profile — your personal defaults (edit freely)\n${stringify(validated)}`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Flattens a profile into dotted `key → value` pairs (the same key space as the
 * `preferences` table), for merging into the effective view.
 */
export function flattenProfile(profile: ProfileFile): ReadonlyMap<PreferenceKey, unknown> {
  return new Map<PreferenceKey, unknown>([
    ['defaults.search_provider', profile.defaults.search_provider],
    ['defaults.detail', profile.defaults.detail],
    ['defaults.length', profile.defaults.length],
    ['locale.region', profile.locale.region],
    ['locale.units', profile.locale.units],
    ['personalization.enabled', profile.personalization.enabled],
    ['personalization.interests', profile.personalization.interests],
    ['personalization.favorite_retailers', profile.personalization.favorite_retailers],
    ['agent.provider', profile.agent.provider],
    ['agent.model', profile.agent.model],
    ['agent.thinking', profile.agent.thinking],
    ['agent.max_duration', profile.agent.max_duration],
    ['agent.max_tokens', profile.agent.max_tokens],
    ['agent.tool_timeout', profile.agent.tool_timeout],
    ['agent.tool_retries', profile.agent.tool_retries],
    ['agent.confirm_timeout', profile.agent.confirm_timeout],
  ]);
}

/** Per-key value schema used to validate `yantra prefs set`. */
const KEY_VALUE_SCHEMAS: Record<PreferenceKey, z.ZodTypeAny> = {
  'defaults.search_provider': searchProviderSchema,
  'defaults.detail': detailSchema,
  'defaults.length': lengthSchema,
  'locale.region': z.string().nullable(),
  'locale.units': unitsSchema,
  'personalization.enabled': z.boolean(),
  'personalization.interests': z.array(z.string()),
  'personalization.favorite_retailers': z.array(z.string()),
  'agent.provider': nullableAgentStringSchema,
  'agent.model': nullableAgentStringSchema,
  'agent.thinking': nullableAgentStringSchema,
  'agent.max_duration': agentDurationSchema,
  'agent.max_tokens': z.number().int().positive(),
  'agent.tool_timeout': agentDurationSchema,
  'agent.tool_retries': z.number().int().nonnegative(),
  'agent.confirm_timeout': agentDurationSchema,
};

/**
 * Validates and coerces a `prefs set` value for a given key. Accepts CLI-string
 * inputs: `true/false` for booleans and comma-separated lists for arrays.
 * Rejects unknown keys with a hint listing the valid keys.
 *
 * @returns the coerced value on success, or an actionable error string.
 */
export function validatePreference(key: string, rawValue: string): Result<unknown, string> {
  if (!isKnownKey(key)) {
    return err(`unknown preference key "${key}". Valid keys: ${KNOWN_PREFERENCE_KEYS.join(', ')}`);
  }

  const coerced = coerceRawValue(key, rawValue);
  const parsed = KEY_VALUE_SCHEMAS[key].safeParse(coerced);
  if (!parsed.success) {
    return err(
      `invalid value for "${key}": ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return ok(parsed.data);
}

function isKnownKey(key: string): key is PreferenceKey {
  return (KNOWN_PREFERENCE_KEYS as readonly string[]).includes(key);
}

/** Coerces the CLI string into the shape the key's schema expects. */
function coerceRawValue(key: PreferenceKey, rawValue: string): unknown {
  if (key === 'personalization.enabled') {
    if (rawValue === 'true') return true;
    if (rawValue === 'false') return false;
    return rawValue; // let the schema reject anything else
  }
  if (key === 'personalization.interests' || key === 'personalization.favorite_retailers') {
    return rawValue
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (key === 'locale.region' && rawValue.toLowerCase() === 'null') {
    return null;
  }
  if (
    (key === 'agent.provider' || key === 'agent.model' || key === 'agent.thinking') &&
    rawValue.toLowerCase() === 'null'
  ) {
    return null;
  }
  if (key === 'agent.max_tokens' || key === 'agent.tool_retries') {
    const value = Number(rawValue);
    return Number.isSafeInteger(value) ? value : rawValue;
  }
  return rawValue;
}
