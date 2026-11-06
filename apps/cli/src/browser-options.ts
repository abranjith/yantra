/**
 * Normalization of the shared browser-selection option group.
 *
 * Registration lives in the command registry (`@yantra/protocol`, FEAT-062)
 * as the `browser-selection` group, so `--browser` and `--browser-path` cannot
 * drift between commands; the rule that decides what a given pair of flags
 * *means* exists exactly once, here.
 *
 * The group is registered only on commands that can actually launch a browser —
 * `run`, `resume`, `ask`, `research`, `do`, and `browser check`. A flag a
 * command cannot act on is a dead control, not shared vocabulary (memory
 * §General), so `daemon`, `schedule`, `init`, `list`, `config`, `doctor`,
 * `browser list`, and `browser use` deliberately reject these flags as unknown
 * options.
 *
 * The result is a *whole* selection, never a field-by-field merge with
 * `config.yaml`: precedence is invocation → config → `auto`, and
 * `--browser system` with no path therefore clears a configured custom path for
 * that invocation rather than inheriting it.
 */

import { isAbsolute, win32 } from 'node:path';

import type { BrowserSelection, BrowserSource } from '@yantra/core';
import { CommanderError } from 'commander';

/** Values of the registry's `browser-selection` option group. */
export interface BrowserSelectionOptions {
  /** `--browser` */
  readonly browser?: string;
  /** `--browser-path` */
  readonly browserPath?: string;
}

const SOURCES: readonly BrowserSource[] = ['auto', 'managed', 'system'];

/**
 * Normalizes the flags into the one selection the resolver takes.
 *
 * @returns The invocation selection, or `undefined` when neither flag was
 * supplied — the resolver then reads `config.yaml`, then falls back to `auto`.
 * @throws {CommanderError} exit 1 for an unknown source, a conflicting pair, or
 * a non-absolute path.
 */
export function resolveBrowserSelectionOverride(
  options: BrowserSelectionOptions,
): BrowserSelection | undefined {
  const rawSource = options.browser;
  const rawPath = options.browserPath;
  if (rawSource === undefined && rawPath === undefined) return undefined;

  let source: BrowserSource | undefined;
  if (rawSource !== undefined) {
    const candidate = rawSource.trim().toLowerCase();
    if (!SOURCES.includes(candidate as BrowserSource)) {
      throw new CommanderError(
        1,
        'yantra.browser.invalid-source',
        `--browser must be one of ${SOURCES.join(', ')}, not "${rawSource}".`,
      );
    }
    source = candidate as BrowserSource;
  }

  if (rawPath === undefined) {
    // `system` with no path means discovery, and that is the whole selection:
    // a configured custom path is cleared for this invocation.
    return { source: source ?? 'auto', executablePath: null };
  }

  // A path names one specific binary, which only `system` can mean. Ranking the
  // two inputs instead of refusing them would silently discard one of them.
  if (source !== undefined && source !== 'system') {
    throw new CommanderError(
      1,
      'yantra.browser.conflicting-selection',
      `--browser-path names a specific executable, which is only meaningful with \`--browser system\`; \`--browser ${source}\` describes how to find a browser instead.`,
    );
  }

  const path = rawPath.trim();
  if (path.length === 0) {
    throw new CommanderError(1, 'yantra.browser.invalid-path', '--browser-path must not be empty.');
  }
  // The same grammar the config schema enforces, so a path accepted here is a
  // path `yantra browser use system --path` would also accept.
  if (!isAbsolute(path) && !win32.isAbsolute(path)) {
    throw new CommanderError(
      1,
      'yantra.browser.invalid-path',
      `--browser-path must be an absolute path, not "${rawPath}".`,
    );
  }

  return { source: 'system', executablePath: path };
}
