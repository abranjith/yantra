/**
 * The persisted browser binding, read and written as one whole selection.
 *
 * `config.yaml` answers "what is installed?", so which browser Yantra launches
 * lives here rather than in `profile.yaml`. There is deliberately no
 * single-field write: a `source` change that leaves a stale `executable_path`
 * behind is the invalid state the config schema refuses, so the writer commits
 * both fields in one mutation and never hands the filesystem an intermediate
 * document.
 */

import { readFile } from 'node:fs/promises';

import { parse as parseYaml } from 'yaml';

import { loadConfig } from '../config/load.js';
import { mutateConfigDocument } from '../config/write.js';

import type { BrowserSelection, BrowserSelectionReader } from './installation-types.js';
import { configPath } from './paths.js';

/** Root YAML key the binding lives under. */
const BROWSER_BLOCK = 'browser';

export interface ConfigBrowserSelectionReaderDeps {
  /** Config path override; defaults to the resolved `config.yaml`. */
  readonly configPath?: string;
  /** Injected for tests. Defaults to the validating loader. */
  readonly load?: typeof loadConfig;
}

/**
 * Reads the persisted binding as the resolver's {@link BrowserSelection}.
 *
 * Returns `undefined` when the block is absent, which is what makes the
 * resolver record `selectionOrigin: 'default'` rather than claiming the user
 * configured `auto` — a distinction `browser list` and `doctor` both render.
 */
export class ConfigBrowserSelectionReader implements BrowserSelectionReader {
  private readonly path: () => string;
  private readonly load: typeof loadConfig;

  constructor(deps: ConfigBrowserSelectionReaderDeps = {}) {
    const override = deps.configPath;
    this.path = override === undefined ? configPath : () => override;
    this.load = deps.load ?? loadConfig;
  }

  /** @inheritdoc */
  async read(): Promise<BrowserSelection | undefined> {
    const path = this.path();
    if (!(await hasBrowserBlock(path))) return undefined;
    const loaded = await this.load(path);
    // An invalid document is not a silent `auto`: reporting "no configured
    // selection" here would hide a configuration failure the user must fix, and
    // the caller already renders `ConfigError` with the offending key.
    if (!loaded.isOk) throw loaded.error;
    const block = loaded.value.browser;
    return { source: block.source, executablePath: block.executable_path };
  }
}

/**
 * Whether the document on disk actually carries a `browser:` block.
 *
 * The schema defaults the block, so a *parsed* config always has one — reading
 * the raw document is the only way to tell "the user chose `auto`" from "the
 * user chose nothing". A malformed document answers `true` so the loader, not
 * this guess, reports the failure.
 */
async function hasBrowserBlock(path: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(contents);
  } catch {
    return true;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  return BROWSER_BLOCK in (parsed as Record<string, unknown>);
}

/**
 * Commits a browser selection, both fields together.
 *
 * `auto` and `managed` always write `executable_path: null`, because a path
 * under either source has no meaning and the schema rejects it. The write goes
 * through `mutateConfigDocument`, so YAML comments and unrelated keys survive
 * and the resulting document is validated before it reaches disk.
 *
 * @throws {ConfigWriteError} when the resulting document is not schema-valid.
 */
export function writeBrowserSelection(selection: BrowserSelection, path?: string): Promise<void> {
  const executablePath = selection.source === 'system' ? selection.executablePath : null;
  return mutateConfigDocument((document) => {
    document.setIn([BROWSER_BLOCK, 'source'], selection.source);
    document.setIn([BROWSER_BLOCK, 'executable_path'], executablePath);
  }, path);
}
