/**
 * Safety assertions for browser runtime log projections (`runtime.jsonl`).
 *
 * The run directory is durable local diagnostics, so the rule these assertions
 * enforce is not "avoid obvious secrets" but "carry only closed, non-
 * identifying fields". Both halves of that rule live here — the banned key
 * names and the banned value substrings — because the events are emitted in
 * `@yantra/core` and read back in `@yantra/agent`, and two copies of the
 * vocabulary would drift the moment one side gained a field.
 *
 * Use {@link assertRuntimeEventIsSafe} at an emit site to prove a builder is
 * safe, and {@link assertRuntimeLinesAreSafe} over a completed run's artifact
 * to prove nothing else wrote into the same file.
 */

/**
 * Keys a runtime projection may never carry, at any depth.
 *
 * `run_id`, `event`, `schema_version`, `tool`, `phase`, and the closed enums
 * are the whole legal vocabulary. Anything that could hold a prose message, a
 * filesystem path, a command line, a URL, or a whole serialized error belongs
 * on this list.
 */
export const FORBIDDEN_RUNTIME_KEYS: readonly string[] = Object.freeze([
  'err',
  'error',
  'stack',
  'cause',
  'args',
  'argv',
  'lastStderr',
  'last_stderr',
  'stderr',
  'detail',
  'remediation',
  'canonicalPath',
  'canonical_path',
  'executablePath',
  'executable_path',
  'profilePath',
  'profile_path',
  'url',
  'href',
  'env',
  'environment',
  'page_content',
  'goal',
]);

function walk(value: unknown, keys: string[], strings: string[]): void {
  if (typeof value === 'string') {
    strings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, keys, strings);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      keys.push(key);
      walk(entry, keys, strings);
    }
  }
}

/** Every string value reachable from `value`, at any depth. */
export const collectRuntimeStrings = (value: unknown): string[] => {
  const strings: string[] = [];
  walk(value, [], strings);
  return strings;
};

/** Every key name reachable from `value`, at any depth. */
export const collectRuntimeKeys = (value: unknown): string[] => {
  const keys: string[] = [];
  walk(value, keys, []);
  return keys;
};

/**
 * Throws when `event` carries a forbidden key or any of `canaries`, at any
 * depth.
 *
 * Takes the parsed object rather than rendered text on purpose: a substring
 * search over JSON passes for a value that was merely truncated mid-secret.
 *
 * @param label Prefix for the thrown message, e.g. `runtime.jsonl line 3`.
 */
export const assertRuntimeEventIsSafe = (
  event: unknown,
  canaries: readonly string[] = [],
  label = 'runtime event',
): void => {
  const keys: string[] = [];
  const strings: string[] = [];
  walk(event, keys, strings);
  const offending = keys.find((key) => FORBIDDEN_RUNTIME_KEYS.includes(key));
  if (offending !== undefined) {
    throw new Error(`${label} carries forbidden key "${offending}": ${JSON.stringify(event)}`);
  }
  for (const canary of canaries) {
    const hit = strings.find((text) => text.includes(canary));
    if (hit !== undefined) {
      throw new Error(`${label} leaked the canary "${canary}" in "${hit}"`);
    }
  }
};

/** Applies {@link assertRuntimeEventIsSafe} to every parsed log line. */
export const assertRuntimeLinesAreSafe = (
  lines: readonly unknown[],
  canaries: readonly string[] = [],
): void => {
  lines.forEach((line, index) => {
    assertRuntimeEventIsSafe(line, canaries, `runtime.jsonl line ${index + 1}`);
  });
};

/** Parses `runtime.jsonl` text into objects. Throws on a malformed line. */
export const parseRuntimeLog = (raw: string): Record<string, unknown>[] =>
  raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch (error) {
        throw new Error(`runtime.jsonl line ${index + 1} is not valid JSON: ${line}`, {
          cause: error,
        });
      }
    });

/** All parsed lines whose `event` field equals `name`. */
export const runtimeEventsNamed = (
  lines: readonly Record<string, unknown>[],
  name: string,
): Record<string, unknown>[] => lines.filter((line) => line.event === name);
