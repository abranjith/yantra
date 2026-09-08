import { readFileSync } from 'node:fs';
import { isAbsolute, join, win32 } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { yantraHome } from '../browser/paths.js';

export type StoragePathSource =
  | 'default'
  | 'env:YANTRA_DATA_DIR'
  | 'env:YANTRA_CACHE_DIR'
  | 'config:paths.data_dir'
  | 'config:paths.cache_dir';

export interface ResolvedStorageDirs {
  readonly dataDir: string;
  readonly cacheDir: string;
}

export interface ResolvedStorageDirsWithSources extends ResolvedStorageDirs {
  readonly dataSource: StoragePathSource;
  readonly cacheSource: StoragePathSource;
}

interface RawPaths {
  readonly data_dir?: unknown;
  readonly cache_dir?: unknown;
}

let memo: ResolvedStorageDirsWithSources | undefined;
let warned = false;

function portableAbsolute(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Pure storage resolution with environment > config > default precedence. */
export function resolveStorageDirs(
  env: NodeJS.ProcessEnv,
  rawConfigText: string | undefined,
  home: string,
): ResolvedStorageDirs {
  const resolved = resolveStorageDirsWithSources(env, rawConfigText, home);
  return { dataDir: resolved.dataDir, cacheDir: resolved.cacheDir };
}

/** Same resolution plus provenance for diagnostics and `yantra config path`. */
export function resolveStorageDirsWithSources(
  env: NodeJS.ProcessEnv,
  rawConfigText: string | undefined,
  home: string,
): ResolvedStorageDirsWithSources {
  let paths: RawPaths = {};
  if (rawConfigText?.trim()) {
    try {
      const parsed = parseYaml(rawConfigText) as { paths?: RawPaths } | null;
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.paths &&
        typeof parsed.paths === 'object'
      ) {
        paths = parsed.paths;
      }
    } catch {
      // The synchronous accessor owns the one-time warning. The pure resolver
      // remains total so callers can safely fall back to the documented roots.
      paths = {};
    }
  }

  const envData = nonEmpty(env.YANTRA_DATA_DIR);
  const envCache = nonEmpty(env.YANTRA_CACHE_DIR);
  const configData = nonEmpty(paths.data_dir);
  const configCache = nonEmpty(paths.cache_dir);

  const dataFromConfig = configData && portableAbsolute(configData) ? configData : undefined;
  const cacheFromConfig = configCache && portableAbsolute(configCache) ? configCache : undefined;
  const dataFromEnv = envData && portableAbsolute(envData) ? envData : undefined;
  const cacheFromEnv = envCache && portableAbsolute(envCache) ? envCache : undefined;

  return {
    dataDir: dataFromEnv ?? dataFromConfig ?? join(home, 'data'),
    cacheDir: cacheFromEnv ?? cacheFromConfig ?? join(home, 'cache'),
    dataSource: dataFromEnv
      ? 'env:YANTRA_DATA_DIR'
      : dataFromConfig
        ? 'config:paths.data_dir'
        : 'default',
    cacheSource: cacheFromEnv
      ? 'env:YANTRA_CACHE_DIR'
      : cacheFromConfig
        ? 'config:paths.cache_dir'
        : 'default',
  };
}

function warn(path: string): void {
  if (warned) return;
  warned = true;
  process.stderr.write(`warning: could not read ${path}; using default storage locations\n`);
}

function current(): ResolvedStorageDirsWithSources {
  if (memo) return memo;
  const home = yantraHome();
  const path = join(home, 'config.yaml');
  let text: string | undefined;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(path);
  }
  if (text?.trim()) {
    try {
      const parsed = parseYaml(text) as { paths?: RawPaths } | null;
      const configured = parsed?.paths;
      if (
        configured &&
        [configured.data_dir, configured.cache_dir].some(
          (value) => nonEmpty(value) !== undefined && !portableAbsolute(nonEmpty(value)!),
        )
      ) {
        warn(path);
      }
    } catch {
      warn(path);
      text = undefined;
    }
  }
  try {
    memo = resolveStorageDirsWithSources(process.env, text, home);
  } catch {
    warn(path);
    memo = resolveStorageDirsWithSources(process.env, undefined, home);
  }
  return memo;
}

export function dataDir(): string {
  return current().dataDir;
}

export function cacheDir(): string {
  return current().cacheDir;
}

export function storageDirSources(): Pick<
  ResolvedStorageDirsWithSources,
  'dataSource' | 'cacheSource'
> {
  const value = current();
  return { dataSource: value.dataSource, cacheSource: value.cacheSource };
}

/** Clears the memoized storage calculation. Intended for config writes and tests. */
export function resetPathCache(): void {
  memo = undefined;
}
