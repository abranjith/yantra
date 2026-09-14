import { constants } from 'node:fs';
import { access, mkdir, statfs } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

import { cftPlatformFor } from './driver-compatibility.js';
import type { ManagedInstallError, ManagedInstallPolicy } from './managed-install-types.js';

export interface ManagedPreflightDeps {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly root: () => string;
  readonly statfs?: typeof statfs;
  readonly access?: typeof access;
  readonly env?: NodeJS.ProcessEnv;
  readonly nodeSupportsEnvProxy?: boolean;
}

export interface ManagedPreflightResult {
  readonly platform: NonNullable<ReturnType<typeof cftPlatformFor>>;
  readonly archiveTools: readonly string[];
}

/** Error wrapper used internally while public outcomes remain plain typed data. */
export class ManagedInstallException extends Error {
  override readonly name = 'ManagedInstallException';

  constructor(readonly context: ManagedInstallError) {
    super(`${context.detail} ${context.remediation}`.trim());
  }
}

/** Runs every local prerequisite before the helper can touch the network. */
export async function managedPreflight(
  deps: ManagedPreflightDeps,
  policy: ManagedInstallPolicy,
): Promise<ManagedPreflightResult> {
  const hostPlatform = deps.platform ?? process.platform;
  const platform = cftPlatformFor(hostPlatform, deps.arch ?? process.arch);
  if (platform === null) {
    throwFailure(
      installFailure(
        'unsupported-platform',
        'preflight',
        'Chrome for Testing is not published for this host. Install a supported external Chrome instead.',
        'This host has no Chrome for Testing artifact.',
      ),
    );
  }

  const env = deps.env ?? process.env;
  const searchedPaths = archiveToolPaths(hostPlatform, env);
  const canAccess = deps.access ?? access;
  const available: string[] = [];
  for (const tool of searchedPaths) {
    try {
      await canAccess(tool, constants.X_OK);
      available.push(tool);
    } catch {
      // Report one classified failure after every supported alternative is tried.
    }
  }
  if (available.length === 0) {
    throwFailure(
      installFailure(
        'archive-tool-missing',
        'preflight',
        `Install one of the archive tools required by this host: ${searchedPaths.join(', ')}.`,
        'No executable archive tool was found.',
        { searchedPaths },
      ),
    );
  }

  const proxy = configuredProxy(env);
  if (proxy !== null && deps.nodeSupportsEnvProxy === false) {
    throwFailure(
      installFailure(
        'proxy-unsupported-runtime',
        'preflight',
        'Use Node 24.15.0 or later so the configured proxy can be honored.',
        'The runtime cannot route downloads through the configured proxy.',
        { proxyHost: proxy },
      ),
    );
  }

  const root = deps.root();
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await canAccess(root, constants.W_OK);
  } catch {
    throwFailure(
      installFailure(
        'insufficient-permissions',
        'preflight',
        `Make ${root} writable and retry.`,
        'Managed browser destination is not writable.',
      ),
    );
  }

  let filesystem: Awaited<ReturnType<typeof statfs>>;
  try {
    filesystem = await (deps.statfs ?? statfs)(root);
  } catch (cause) {
    throwFailure(
      installFailure(
        'insufficient-permissions',
        'preflight',
        `Verify that ${root} is accessible and retry.`,
        `Free-space inspection failed: ${describe(cause)}.`,
      ),
    );
  }
  const freeBytes = filesystem.bavail * filesystem.bsize;
  if (freeBytes < policy.requiredFreeBytes) {
    throwFailure(
      installFailure(
        'insufficient-disk-space',
        'preflight',
        `Free at least ${policy.requiredFreeBytes - freeBytes} bytes in ${root} and retry.`,
        `The managed browser destination has ${freeBytes} free bytes; ${policy.requiredFreeBytes} are required.`,
      ),
    );
  }

  return { platform, archiveTools: available };
}

/** Exact executable paths searched for the upstream ZIP extraction strategy. */
export function archiveToolPaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const commands = platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['unzip'];
  const fromPath = commands.flatMap((command) => commandSearchPaths(command, platform, env));
  if (platform !== 'win32') return fromPath;
  return [...new Set([join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ...fromPath])];
}

function commandSearchPaths(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  if (isAbsolute(command)) return [command];
  const directories = (env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const extensions =
    platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const hasExtension = /\.[A-Za-z0-9]+$/u.test(command);
  return directories.flatMap((directory) =>
    hasExtension
      ? [join(directory, command)]
      : extensions.map((extension) => join(directory, `${command}${extension.toLowerCase()}`)),
  );
}

function configuredProxy(env: NodeJS.ProcessEnv): string | null {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const) {
    const value = env[key]?.trim();
    if (value) return proxyHost(value);
  }
  return null;
}

export function stripProxyCredentials(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value.replace(/\/\/[^/@]*@/u, '//');
  }
}

function proxyHost(value: string): string {
  try {
    const url = new URL(value);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return stripProxyCredentials(value);
  }
}

export function installFailure(
  code: ManagedInstallError['code'],
  phase: ManagedInstallError['phase'],
  remediation: string,
  detail: string,
  extra: Partial<ManagedInstallError> = {},
): ManagedInstallError {
  return { code, phase, remediation, detail, retainedOrphan: null, ...extra };
}

export function throwFailure(error: ManagedInstallError): never {
  throw new ManagedInstallException(error);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
