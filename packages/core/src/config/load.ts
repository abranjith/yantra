import { readFile } from 'node:fs/promises';

import { err, ok, type Result } from '@yantra/protocol';
import { parse as parseYaml } from 'yaml';
import type { ZodIssue } from 'zod';

import { configPath } from '../browser/paths.js';

import { configSchema, type YantraConfig } from './schema.js';

export interface ConfigIssue {
  readonly keyPath: string;
  readonly message: string;
  readonly suggestion?: string;
}

/** Renders one issue as `<key>: <message> (did you mean <suggestion>?)`. */
export function formatConfigIssue(issue: ConfigIssue): string {
  const suffix = issue.suggestion ? ` (did you mean ${issue.suggestion}?)` : '';
  return `${issue.keyPath || '(root)'}: ${issue.message}${suffix}`;
}

export class ConfigError extends Error {
  /**
   * The message always names the offending keys, so a caller that only has
   * `error.message` — anything rethrowing this out of a `Result` — still
   * reports which key failed rather than just which file did.
   */
  public constructor(
    summary: string,
    public readonly path: string,
    public readonly issues: readonly ConfigIssue[],
  ) {
    const details = issues.map(formatConfigIssue).join('; ');
    super(details ? `${summary} ${details}` : summary);
    this.name = 'ConfigError';
  }
}

export function defaultConfig(): YantraConfig {
  return configSchema.parse({});
}

export async function loadConfig(
  path: string = configPath(),
): Promise<Result<YantraConfig, ConfigError>> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ok(defaultConfig());
    return err(
      new ConfigError(`Could not read ${path}.`, path, [
        { keyPath: '', message: safeMessage(error) },
      ]),
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(contents);
  } catch (error) {
    return err(
      new ConfigError(`Malformed YAML in ${path}.`, path, [
        { keyPath: '', message: safeMessage(error) },
      ]),
    );
  }

  const parsed = configSchema.safeParse(raw ?? {});
  if (parsed.success) return ok(parsed.data);
  const issues = parsed.error.issues.flatMap(toConfigIssues);
  return err(new ConfigError(`Invalid configuration in ${path}.`, path, issues));
}

const siblingKeys: Readonly<Record<string, readonly string[]>> = {
  '': ['version', 'paths', 'models', 'search', 'ethics', 'retention', 'agent'],
  paths: ['data_dir', 'cache_dir'],
  search: ['provider', 'fallback_chain', 'fetch_top', 'tavily', 'brave'],
  'search.tavily': ['api_key'],
  'search.brave': ['api_key'],
  ethics: ['robots_enabled', 'user_agent', 'rate_limit'],
  'ethics.rate_limit': ['default', 'overrides'],
  'ethics.rate_limit.default': ['tokens_per_second', 'burst'],
  retention: ['runs_days', 'corrupt_index_keep'],
  agent: ['pi_auth_path'],
};

function toConfigIssues(issue: ZodIssue): readonly ConfigIssue[] {
  const parent = issue.path.join('.');
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => {
      const suggestion = nearest(key, siblingKeys[parent] ?? []);
      return {
        keyPath: parent ? `${parent}.${key}` : key,
        message: `unknown key "${key}"`,
        ...(suggestion ? { suggestion } : {}),
      };
    });
  }
  return [{ keyPath: parent, message: issue.message }];
}

function nearest(input: string, candidates: readonly string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  return [...candidates].sort((a, b) => distance(input, a) - distance(input, b))[0];
}

function distance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => index);
  for (let r = 1; r <= right.length; r += 1) {
    let previous = rows[0] ?? 0;
    rows[0] = r;
    for (let c = 1; c <= left.length; c += 1) {
      const held = rows[c] ?? 0;
      rows[c] = Math.min(
        (rows[c] ?? 0) + 1,
        (rows[c - 1] ?? 0) + 1,
        previous + (left[c - 1] === right[r - 1] ? 0 : 1),
      );
      previous = held;
    }
  }
  return rows[left.length] ?? right.length;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
