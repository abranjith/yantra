import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

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
  createLocalBrowserRuntimeServices,
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

/** The directory name the managed browser tree occupies under the data dir. */
const MANAGED_TREE_DIRNAME = 'browsers';

/**
 * What relocation will do with the managed browser tree.
 *
 * The tree holds hundreds of megabytes of re-downloadable binaries, so a
 * cross-volume relocation drops it rather than copying it; on the same volume
 * it simply moves with everything else.
 */
export type ManagedTreeAction = 'absent' | 'move' | 'drop-and-reinstall';

export interface ManagedTreeDecision {
  readonly action: ManagedTreeAction;
  readonly path: string;
  /** Rendered verbatim in human and JSON output, and in `--dry-run`. */
  readonly note: string;
}

export interface DataDirDependencies {
  /** True while a Yantra-managed browser run holds the installation open. */
  readonly hasActiveManagedUse: () => Promise<boolean>;
  /**
   * Managed-tree handling for this relocation.
   *
   * Injected rather than spied on: a module-level spy cannot observe an
   * internal call to a sibling function, so the cross-volume branch would be
   * untestable without a second real volume.
   */
  readonly decideManagedTree?: (source: string, target: string) => Promise<ManagedTreeDecision>;
}

const DATA_DIR_DEPENDENCIES: DataDirDependencies = {
  hasActiveManagedUse: () => createLocalBrowserRuntimeServices().coordinator.hasActiveUse(),
};

export interface MoveDirectoryDependencies {
  readonly stat: typeof stat;
  readonly mkdir: typeof mkdir;
  readonly rename: typeof rename;
  readonly cp: typeof cp;
  readonly rm: typeof rm;
}

const MOVE_DIRECTORY_FS: MoveDirectoryDependencies = { stat, mkdir, rename, cp, rm };

export function makeConfigCommand(deps: DataDirDependencies = DATA_DIR_DEPENDENCIES): Command {
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
    .action((path: string | undefined, options: DataDirOptions) => runDataDir(path, options, deps));
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

/**
 * Decides what relocation does with the managed browser tree.
 *
 * The decision is made *before* anything moves so `--dry-run` can report it
 * honestly, and so the human and JSON outputs describe the same plan the
 * command then carries out.
 */
export async function decideManagedTree(
  source: string,
  target: string,
  fs: MoveDirectoryDependencies = MOVE_DIRECTORY_FS,
): Promise<ManagedTreeDecision> {
  const managedRoot = join(source, MANAGED_TREE_DIRNAME);
  try {
    const info = await fs.stat(managedRoot);
    if (!info.isDirectory())
      return { action: 'absent', path: managedRoot, note: 'no managed browser installation' };
    if (await onSameVolume(managedRoot, target, fs)) {
      return {
        action: 'move',
        path: managedRoot,
        note: 'managed browsers move with the data directory',
      };
    }
    return {
      action: 'drop-and-reinstall',
      path: managedRoot,
      note: 'managed browsers are not copied across volumes; run `yantra browser install` afterwards',
    };
  } catch {
    return { action: 'absent', path: managedRoot, note: 'no managed browser installation' };
  }
}

/**
 * Compares filesystem device identity for the source and the target's nearest
 * existing ancestor.
 *
 * A cross-volume move cannot be a rename, so the choice is made up front rather
 * than discovered halfway through by an EXDEV on a gigabyte of binaries.
 */
async function onSameVolume(
  source: string,
  target: string,
  fs: MoveDirectoryDependencies,
): Promise<boolean> {
  let candidate = resolve(target);
  for (;;) {
    try {
      const [a, b] = await Promise.all([fs.stat(source), fs.stat(candidate)]);
      return a.dev === b.dev;
    } catch {
      const parent = resolve(candidate, '..');
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}

/** Is `child` genuinely inside `parent`, and not `parent` itself? */
function isContainedIn(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  if (rel.length === 0 || rel === '..') return false;
  return !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && !win32.isAbsolute(rel);
}

async function runDataDir(
  target: string | undefined,
  options: DataDirOptions,
  deps: DataDirDependencies = DATA_DIR_DEPENDENCIES,
): Promise<void> {
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
  // Relocation is a first-class caller of the managed-use contract: on Windows a
  // live managed chrome.exe holds its own binary open, so the move would fail
  // partway and leave exactly the half-relocated state this refusal prevents.
  // Checked before any filesystem mutation.
  if (await deps.hasActiveManagedUse())
    fail(
      'data relocation is unavailable while a Yantra-managed browser run is active; stop the running sessions and retry',
      3,
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

  const willMove = options.move !== false;
  const decide = deps.decideManagedTree ?? decideManagedTree;
  const managed: ManagedTreeDecision = willMove
    ? await decide(source, target)
    : {
        action: 'absent',
        path: join(source, MANAGED_TREE_DIRNAME),
        note: 'nothing is moved, so the managed tree stays where it is',
      };
  const plan = { from: source, to: target, move: willMove, managedBrowsers: managed };

  if (options.dryRun) {
    if (options.json) emit('config.data-dir', { dryRun: true, ...plan });
    else {
      process.stdout.write(`Would ${plan.move ? 'move' : 'configure'} ${source} -> ${target}\n`);
      process.stdout.write(`Managed browsers: ${managed.action} - ${managed.note}\n`);
    }
    return;
  }

  if (willMove) {
    if (targetExists && targetEntries.length === 0) await rm(target, { recursive: false });
    await moveDirectory(source, target, targetEntries.length > 0, MOVE_DIRECTORY_FS, {
      // A cross-volume relocation excludes the managed tree from the copy
      // rather than duplicating hundreds of megabytes of re-downloadable binaries.
      exclude: managed.action === 'drop-and-reinstall' ? managed.path : null,
    });
  }
  try {
    await setConfigKey('paths.data_dir', target);
  } catch (error) {
    // The rollback stays honest about what it can undo: a single rename, never
    // a copy-based cross-volume move of files it did not copy.
    if (willMove && managed.action !== 'drop-and-reinstall')
      await rename(target, source).catch(() => undefined);
    fail(
      `relocation setting was not written: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }

  // Only after the rest of the relocation has committed: remove the excluded
  // managed tree at the source, under canonical containment, never its parent.
  if (willMove && managed.action === 'drop-and-reinstall') {
    if (!isContainedIn(managed.path, source))
      fail(`refusing to remove ${managed.path}: it is not contained in ${source}`, 2);
    await rm(managed.path, { recursive: true, force: true }).catch(() => undefined);
  }

  resetPathCache();
  if (options.json) emit('config.data-dir', { status: 'relocated', ...plan });
  else {
    process.stdout.write(
      `${plan.move ? 'Moved' : 'Configured'} data directory: ${source} -> ${target}\n`,
    );
    process.stdout.write(`Managed browsers: ${managed.action} - ${managed.note}\n`);
  }
}

export async function moveDirectory(
  source: string,
  target: string,
  merge: boolean,
  fs: MoveDirectoryDependencies = MOVE_DIRECTORY_FS,
  opts: { readonly exclude?: string | null } = {},
): Promise<void> {
  const exclude = opts.exclude ?? null;
  const copyOptions = {
    recursive: true as const,
    force: true as const,
    errorOnExist: false as const,
    ...(exclude === null ? {} : { filter: (src: string) => resolve(src) !== resolve(exclude) }),
  };
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
  // Excluding a subtree makes a plain rename impossible, so that case takes the
  // copy path even on the same volume.
  if (merge || exclude !== null) {
    try {
      await fs.cp(source, target, copyOptions);
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
    await fs.cp(source, target, copyOptions);
  } catch (error) {
    fail(
      `cross-volume copy failed; source remains at ${source}: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
  await fs.rm(source, { recursive: true, force: true });
}
