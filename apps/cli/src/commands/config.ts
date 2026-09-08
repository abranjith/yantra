import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, win32 } from 'node:path';

import {
  cacheDir,
  configSchema,
  configPath,
  dataDir,
  defaultConfig,
  FileDaemonLock,
  indexDbPath,
  loadConfig,
  profilePath,
  redactConfigRefs,
  resetPathCache,
  runsRoot,
  setConfigKey,
  storageDirSources,
  templatesRoot,
  unsetConfigKey,
  workflowsRoot,
  yantraHome,
} from '@yantra/core';
import { Command, CommanderError } from 'commander';
import { parse as parseYaml, stringify } from 'yaml';

import { keyOwner } from '../key-ownership.js';
import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';

interface ConfigOptions {
  readonly json?: boolean;
}
interface DataDirOptions extends ConfigOptions {
  readonly force?: boolean;
  readonly move?: boolean;
  readonly dryRun?: boolean;
}

export interface MoveDirectoryDependencies {
  readonly stat: typeof stat;
  readonly mkdir: typeof mkdir;
  readonly rename: typeof rename;
  readonly cp: typeof cp;
  readonly rm: typeof rm;
}

const MOVE_DIRECTORY_FS: MoveDirectoryDependencies = { stat, mkdir, rename, cp, rm };

export function makeConfigCommand(): Command {
  const command = new Command('config').description(
    'Inspect and update installation configuration',
  );
  command
    .command('path')
    .option('--json', 'emit JSON', false)
    .action((options: ConfigOptions) => runPath(options));
  command
    .command('list')
    .option('--json', 'emit JSON', false)
    .action((options: ConfigOptions) => runList(options));
  command
    .command('get')
    .argument('<key>')
    .option('--json', 'emit JSON', false)
    .action((key: string, options: ConfigOptions) => runGet(key, options));
  command
    .command('set')
    .argument('<key>')
    .argument('<value>')
    .option('--json', 'emit JSON', false)
    .action((key: string, value: string, options: ConfigOptions) => runSet(key, value, options));
  command
    .command('unset')
    .argument('<key>')
    .option('--json', 'emit JSON', false)
    .action((key: string, options: ConfigOptions) => runUnset(key, options));
  command
    .command('edit')
    .option('--json', 'emit JSON', false)
    .action((options: ConfigOptions) => runEdit(options));
  command
    .command('validate')
    .option('--json', 'emit JSON', false)
    .action((options: ConfigOptions) => runValidate(options));
  command
    .command('data-dir')
    .argument('[path]')
    .option('--force', 'allow a non-empty target', false)
    .option('--no-move', 'write the setting without moving content')
    .option('--dry-run', 'print the relocation plan without changing anything', false)
    .option('--json', 'emit JSON', false)
    .action((path: string | undefined, options: DataDirOptions) => runDataDir(path, options));
  return command;
}

function emit(kind: string, body: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind, ...body })}\n`,
  );
}

function fail(message: string, exitCode = 1): never {
  process.stderr.write(`Error: ${message}\n`);
  throw new CommanderError(exitCode, 'yantra.config.failed', message);
}

async function validated() {
  const result = await loadConfig();
  // ConfigError's message already names every offending key.
  if (!result.isOk) fail(result.error.message);
  return result.value;
}

function pathRows() {
  const sources = storageDirSources();
  const homeSource = process.env.YANTRA_HOME?.trim() ? 'env:YANTRA_HOME' : 'default';
  return [
    { name: 'home', path: yantraHome(), source: homeSource },
    { name: 'config', path: configPath(), source: homeSource },
    { name: 'profile', path: profilePath(), source: homeSource },
    { name: 'data', path: dataDir(), source: sources.dataSource },
    { name: 'cache', path: cacheDir(), source: sources.cacheSource },
    { name: 'runs', path: runsRoot(), source: sources.dataSource },
    { name: 'workflows', path: workflowsRoot(), source: sources.dataSource },
    { name: 'templates', path: templatesRoot(), source: sources.dataSource },
    { name: 'index.db', path: indexDbPath(), source: sources.dataSource },
  ];
}

function runPath(options: ConfigOptions): void {
  const rows = pathRows();
  if (options.json) emit('config.path', { rows });
  else for (const row of rows) process.stdout.write(`${row.name}\t${row.path}\t${row.source}\n`);
}

async function runList(options: ConfigOptions): Promise<void> {
  const config = redactConfigRefs(await validated());
  if (options.json) emit('config.list', { config });
  else process.stdout.write(stringify(config));
}

async function runGet(key: string, options: ConfigOptions): Promise<void> {
  const config = redactConfigRefs(await validated()) as Record<string, unknown>;
  let value: unknown = config;
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object' || !(part in value))
      fail(`unknown config key "${key}"`);
    value = (value as Record<string, unknown>)[part];
  }
  if (options.json) emit('config.get', { key, value });
  else process.stdout.write(`${typeof value === 'string' ? value : stringify(value).trim()}\n`);
}

async function runSet(key: string, rawValue: string, options: ConfigOptions): Promise<void> {
  if (keyOwner(key) === 'prefs')
    fail(`that is a personalization key - use: yantra prefs set ${key} ${rawValue}`);
  if (keyOwner(key) !== 'config') fail(`unknown config key "${key}"`);
  let value: unknown;
  try {
    value = parseYaml(rawValue);
  } catch (error) {
    fail(`invalid YAML value: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await setConfigKey(key, value);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  resetPathCache();
  if (options.json) emit('config.set', { status: 'set', key });
  else process.stdout.write(`Set ${key}.\n`);
}

async function runUnset(key: string, options: ConfigOptions): Promise<void> {
  if (keyOwner(key) !== 'config') fail(`unknown config key "${key}"`);
  try {
    await unsetConfigKey(key);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  resetPathCache();
  if (options.json) emit('config.unset', { status: 'unset', key });
  else process.stdout.write(`Unset ${key}; the schema default now applies.\n`);
}

async function runEdit(options: ConfigOptions): Promise<void> {
  const path = configPath();
  let original: string;
  try {
    original = await readFile(path, 'utf8');
  } catch {
    original = stringify(defaultConfig());
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, original, { mode: 0o600 });
  }
  const editor = process.env.EDITOR?.trim();
  if (!editor) fail('$EDITOR is not set');
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(editor, [path], { shell: true, stdio: 'inherit' });
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    await writeFile(path, original, { mode: 0o600 });
    fail(`editor exited with code ${exitCode}`);
  }
  const result = await loadConfig(path);
  if (!result.isOk) {
    await writeFile(path, original, { mode: 0o600 });
    fail(`${result.error.message}; restored the original file`);
  }
  resetPathCache();
  if (options.json) emit('config.edit', { status: 'saved', path });
  else process.stdout.write(`Saved ${path}.\n`);
}

async function runValidate(options: ConfigOptions): Promise<void> {
  await validated();
  if (options.json) emit('config.validate', { valid: true, path: configPath() });
  else process.stdout.write(`${configPath()} is valid.\n`);
}

async function runDataDir(target: string | undefined, options: DataDirOptions): Promise<void> {
  const source = dataDir();
  const sourceLabel = storageDirSources().dataSource;
  if (!target) {
    if (options.json) emit('config.data-dir', { path: source, source: sourceLabel });
    else process.stdout.write(`${source}\t${sourceLabel}\n`);
    return;
  }
  const absolute = isAbsolute(target) || win32.isAbsolute(target);
  if (!absolute) fail('data directory must be an absolute path');
  const normalizedSource = source.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase();
  const normalizedTarget = target.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase();
  if (
    normalizedTarget === normalizedSource ||
    normalizedTarget.startsWith(`${normalizedSource}/`)
  ) {
    fail('target must not be the current data directory or nested inside it');
  }
  const currentConfig = await validated();
  const candidate = configSchema.safeParse({
    ...currentConfig,
    paths: { ...currentConfig.paths, data_dir: target },
  });
  if (!candidate.success) {
    const issue = candidate.error.issues[0];
    fail(`invalid data directory: ${issue?.message ?? 'configuration constraint failed'}`);
  }
  const lock = await new FileDaemonLock().probe();
  if (lock)
    fail(
      `data relocation is unavailable while the daemon or a run holds the lock${lock.pid ? ` (pid ${lock.pid})` : ''}`,
    );
  let targetEntries: readonly string[] = [];
  let targetExists = false;
  try {
    targetEntries = await readdir(target);
    targetExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      fail(`cannot inspect target: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  if (targetEntries.length > 0 && !options.force)
    fail('target exists and is non-empty; pass --force to continue');
  const plan = { from: source, to: target, move: options.move !== false };
  if (options.dryRun) {
    if (options.json) emit('config.data-dir', { dryRun: true, ...plan });
    else process.stdout.write(`Would ${plan.move ? 'move' : 'configure'} ${source} -> ${target}\n`);
    return;
  }
  if (options.move !== false) {
    if (targetExists && targetEntries.length === 0) await rm(target, { recursive: false });
    await moveDirectory(source, target, targetEntries.length > 0);
  }
  try {
    await setConfigKey('paths.data_dir', target);
  } catch (error) {
    if (options.move !== false) await rename(target, source).catch(() => undefined);
    fail(
      `relocation setting was not written: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
  resetPathCache();
  if (options.json) emit('config.data-dir', { status: 'relocated', ...plan });
  else
    process.stdout.write(
      `${plan.move ? 'Moved' : 'Configured'} data directory: ${source} -> ${target}\n`,
    );
}

export async function moveDirectory(
  source: string,
  target: string,
  merge: boolean,
  fs: MoveDirectoryDependencies = MOVE_DIRECTORY_FS,
): Promise<void> {
  try {
    await fs.stat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      return;
    }
    fail(`cannot inspect source: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (merge) {
    try {
      await fs.cp(source, target, { recursive: true, force: true, errorOnExist: false });
      await fs.rm(source, { recursive: true, force: true });
      return;
    } catch (error) {
      fail(
        `copy failed; source remains at ${source}: ${error instanceof Error ? error.message : String(error)}`,
        2,
      );
    }
  }
  try {
    await fs.rename(source, target);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      fail(
        `could not move data directory: ${error instanceof Error ? error.message : String(error)}`,
        2,
      );
    }
  }
  try {
    await fs.cp(source, target, { recursive: true, force: true, errorOnExist: false });
  } catch (error) {
    fail(
      `cross-volume copy failed; source remains at ${source}: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
  await fs.rm(source, { recursive: true, force: true });
}
