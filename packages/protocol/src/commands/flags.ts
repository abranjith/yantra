/**
 * Commander 14's option-flags grammar, reproduced so registry data can be
 * checked against its own `flags` string and so the invocation parser can
 * address options exactly as commander does. Browser-safe.
 */

/** The fields commander derives from one flags string. */
export interface ParsedOptionFlags {
  readonly long: string;
  readonly short?: string;
  readonly value: 'none' | 'required' | 'optional';
  readonly variadic: boolean;
  readonly negatable: boolean;
  readonly attribute: string;
}

/** Commander's camelcase: `auth-secret` → `authSecret`. */
function camelcase(name: string): string {
  return name
    .split('-')
    .reduce((joined, word) => joined + (word[0] ?? '').toUpperCase() + word.slice(1));
}

/**
 * The commander attribute for a long flag: `--auth-secret` → `authSecret`,
 * `--no-llm` → `llm`.
 */
export function attributeForLong(long: string): string {
  return camelcase(long.replace(/^--/, '').replace(/^no-/, ''));
}

/**
 * Parses a flags string such as `-p, --params <key=value...>` the way
 * commander's `Option` constructor does. Returns `null` when there is no long
 * flag, which the registry does not allow.
 */
export function parseOptionFlags(flags: string): ParsedOptionFlags | null {
  const parts = flags.split(/[ |,]+/);
  let short: string | undefined;
  let long: string | undefined;
  if (parts[0] !== undefined && /^-[^-]$/.test(parts[0])) short = parts.shift();
  if (parts[0] !== undefined && /^--[^-]/.test(parts[0])) long = parts.shift();
  if (long === undefined) return null;
  const value = flags.includes('<') ? 'required' : flags.includes('[') ? 'optional' : 'none';
  return {
    long,
    ...(short === undefined ? {} : { short }),
    value,
    variadic: /\w\.\.\.[>\]]$/.test(flags),
    negatable: long.startsWith('--no-'),
    attribute: attributeForLong(long),
  };
}
