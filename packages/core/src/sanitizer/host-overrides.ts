import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { SanitizationProfileError } from './errors.js';
import type { SanitizationProfile } from './profiles.js';

export type ExtraRedactorTag = 'currency_usd' | 'date_of_birth' | 'case_number';

export interface HostOverride {
  readonly hostPattern: string;
  readonly inherits: SanitizationProfile;
  readonly extraRedactors: readonly ExtraRedactorTag[];
}

export interface HostOverrideStore {
  load(path?: string): Promise<readonly HostOverride[]>;
  reload(): Promise<void>;
  match(host: string): HostOverride | null;
}

interface CompiledHostOverride {
  readonly override: HostOverride;
  readonly matcher: RegExp;
}

const extraRedactorSchema = z.enum(['currency_usd', 'date_of_birth', 'case_number']);
const hostOverrideConfigSchema = z.object({
  version: z.literal(1),
  hosts: z.record(
    z.string(),
    z.object({
      inherits: z.enum(['public', 'read-only-data', 'authenticated']),
      extra_redactors: z.array(extraRedactorSchema).default([]),
    }),
  ),
});

const USER_OVERRIDE_PATH = join(homedir(), '.config', 'yantra', 'sanitizer-hosts.yaml');
const DEFAULT_OVERRIDE_FILE_URL = new URL('./default-host-overrides.yaml', import.meta.url);

export const DEFAULT_HOST_OVERRIDES: readonly HostOverride[] = Object.freeze([
  Object.freeze({
    hostPattern: '*.chase.com',
    inherits: 'authenticated',
    extraRedactors: Object.freeze<readonly ExtraRedactorTag[]>(['currency_usd']),
  }),
  Object.freeze({
    hostPattern: '*.bankofamerica.com',
    inherits: 'authenticated',
    extraRedactors: Object.freeze<readonly ExtraRedactorTag[]>(['currency_usd']),
  }),
  Object.freeze({
    hostPattern: '*.mychart.com',
    inherits: 'authenticated',
    extraRedactors: Object.freeze<readonly ExtraRedactorTag[]>(['date_of_birth']),
  }),
  Object.freeze({
    hostPattern: '*.uscis.gov',
    inherits: 'authenticated',
    extraRedactors: Object.freeze<readonly ExtraRedactorTag[]>(['case_number']),
  }),
]);

/**
 * Read sanitizer host overrides from user config with default fallback.
 */
export class FileHostOverrideStore implements HostOverrideStore {
  private activePath: string;
  private cached: readonly HostOverride[] = DEFAULT_HOST_OVERRIDES;
  private compiled: readonly CompiledHostOverride[] = compileOverrides(DEFAULT_HOST_OVERRIDES);

  public constructor(path = USER_OVERRIDE_PATH) {
    this.activePath = path;
  }

  public async load(path = this.activePath): Promise<readonly HostOverride[]> {
    this.activePath = path;

    const fromDisk = await this.readOverrides(path);
    this.cached = fromDisk;
    this.compiled = compileOverrides(fromDisk);

    return this.cached;
  }

  public async reload(): Promise<void> {
    await this.load(this.activePath);
  }

  public match(host: string): HostOverride | null {
    const normalizedHost = normalizeHost(host);
    for (const entry of this.compiled) {
      if (entry.matcher.test(normalizedHost)) {
        return entry.override;
      }
    }
    return null;
  }

  private async readOverrides(path: string): Promise<readonly HostOverride[]> {
    const sourceText = await readYamlWithDefault(path);

    let parsed: unknown;
    try {
      parsed = parseYaml(sourceText);
    } catch (error) {
      throw new SanitizationProfileError('Failed to parse sanitizer host override YAML.', {
        filePath: path,
        cause: error,
      });
    }

    const validated = hostOverrideConfigSchema.safeParse(parsed);
    if (!validated.success) {
      throw new SanitizationProfileError('Sanitizer host override file is malformed.', {
        filePath: path,
        cause: validated.error,
      });
    }

    return Object.entries(validated.data.hosts).map(([pattern, config]) =>
      Object.freeze({
        hostPattern: pattern,
        inherits: config.inherits,
        extraRedactors: Object.freeze([...config.extra_redactors]),
      }),
    );
  }
}

export function matchHostOverride(
  host: string,
  overrides: readonly HostOverride[],
): HostOverride | null {
  const normalizedHost = normalizeHost(host);
  for (const override of overrides) {
    if (globToRegExp(override.hostPattern).test(normalizedHost)) {
      return override;
    }
  }
  return null;
}

export function normalizeHost(hostHint: string): string {
  try {
    const fromUrl = new URL(hostHint);
    return fromUrl.hostname.toLowerCase();
  } catch {
    return hostHint.toLowerCase();
  }
}

async function readYamlWithDefault(path: string): Promise<string> {
  try {
    await access(path);
    return await readFile(path, 'utf8');
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException;
    if (maybeError.code !== 'ENOENT') {
      throw new SanitizationProfileError('Unable to read sanitizer host override file.', {
        filePath: path,
        cause: error,
      });
    }
    return readFile(DEFAULT_OVERRIDE_FILE_URL, 'utf8');
  }
}

function compileOverrides(overrides: readonly HostOverride[]): readonly CompiledHostOverride[] {
  return overrides.map((override) => ({
    override,
    matcher: globToRegExp(override.hostPattern),
  }));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/-/g, '\\-');

  return new RegExp(`^${escaped}$`, 'i');
}
