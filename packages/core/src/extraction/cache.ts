import { mkdir, readdir, readFile, rename, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

import type { Brief } from '@yantra/protocol';

import { cacheDir } from '../browser/paths.js';
import type { Logger } from '../browser/types.js';

import type { SearchProviderName } from './types.js';

export interface AskCachePutMeta {
  readonly query: string;
  readonly searchProvider: SearchProviderName;
  readonly utcDay: string;
}

export interface AskCache {
  get(key: string): Promise<Brief | null>;
  put(key: string, brief: Brief, meta?: AskCachePutMeta): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Cache entry version. Bumped to 2 for the FEAT-015 Brief cutover: version-1
 * card entries no longer parse into this shape and are treated as misses.
 */
const CACHE_VERSION = 2 as const;

interface CacheFileShape {
  readonly version: typeof CACHE_VERSION;
  readonly query: string;
  readonly search_provider: SearchProviderName;
  readonly utc_day: string;
  readonly created_at: string;
  readonly ttl_seconds: number;
  readonly brief: Brief;
}

/* eslint-disable @typescript-eslint/no-empty-function */
const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
/* eslint-enable @typescript-eslint/no-empty-function */

export interface FileSystemAskCacheOptions {
  readonly dir?: string;
  readonly ttlSeconds?: number;
  readonly maxBytes?: number;
  readonly logger?: Logger;
  readonly clock?: () => Date;
}

/**
 * File-system backed ask cache.
 */
export class FileSystemAskCache implements AskCache {
  private readonly dir: string;
  private readonly ttlSeconds: number;
  private readonly maxBytes: number;
  private readonly logger: Logger;
  private readonly clock: () => Date;
  private initialized = false;

  public constructor(options: FileSystemAskCacheOptions = {}) {
    this.dir = options.dir ?? join(cacheDir(), 'ask');
    this.ttlSeconds = options.ttlSeconds ?? 86_400;
    this.maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
    this.logger = options.logger ?? noopLogger;
    this.clock = options.clock ?? (() => new Date());
  }

  public async get(key: string): Promise<Brief | null> {
    await this.ensureReady();

    const filePath = this.filePathFor(key);
    let parsed: CacheFileShape;
    try {
      const raw = await readFile(filePath, 'utf8');
      parsed = JSON.parse(raw) as CacheFileShape;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return null;
      }

      this.logger.warn(
        { err: serializeError(error), key },
        'ask cache read failed; treating as miss',
      );
      return null;
    }

    // Legacy (version-1 card) entries are misses after the Brief cutover.
    if (parsed.version !== CACHE_VERSION || this.isExpired(parsed)) {
      await this.delete(key);
      return null;
    }

    return parsed.brief;
  }

  public async put(key: string, brief: Brief, meta?: AskCachePutMeta): Promise<void> {
    await this.ensureReady();

    const now = this.clock().toISOString();
    const payload: CacheFileShape = {
      version: CACHE_VERSION,
      query: meta?.query ?? '',
      search_provider: meta?.searchProvider ?? 'duckduckgo',
      utc_day: meta?.utcDay ?? now.slice(0, 10),
      created_at: now,
      ttl_seconds: this.ttlSeconds,
      brief,
    };

    const target = this.filePathFor(key);
    const temp = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;

    await writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
    await rename(temp, target);

    await this.evictIfNeeded();
  }

  public async delete(key: string): Promise<void> {
    await this.ensureReady();
    await rm(this.filePathFor(key), { force: true });
  }

  private async ensureReady(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await mkdir(this.dir, { recursive: true });
    try {
      await chmod(this.dir, 0o700);
    } catch {
      // chmod is best-effort on Windows and some filesystems.
    }

    this.initialized = true;
  }

  private filePathFor(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  private isExpired(entry: CacheFileShape): boolean {
    const created = Date.parse(entry.created_at);
    if (Number.isNaN(created)) {
      return true;
    }

    const deadline = created + entry.ttl_seconds * 1000;
    return this.clock().getTime() > deadline;
  }

  private async evictIfNeeded(): Promise<void> {
    const files = await readdir(this.dir);
    const jsonFiles = files.filter((fileName) => fileName.endsWith('.json'));

    const entries = await Promise.all(
      jsonFiles.map(async (fileName) => {
        const filePath = join(this.dir, fileName);
        const stats = await stat(filePath);
        return {
          fileName,
          filePath,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        };
      }),
    );

    let totalBytes = entries.reduce((acc, entry) => acc + entry.size, 0);
    if (totalBytes <= this.maxBytes) {
      return;
    }

    entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const entry of entries) {
      if (totalBytes <= this.maxBytes) {
        break;
      }
      await rm(entry.filePath, { force: true });
      totalBytes -= entry.size;
    }
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}

function serializeError(error: unknown): { message: string } {
  if (error instanceof Error) {
    return { message: error.message };
  }

  return { message: String(error) };
}
