/**
 * Resolvability validation for a custom browser path.
 *
 * This is deliberately *not* a compatibility probe. Setting a preference must
 * never cost a browser launch, and it must not fail on a host where launching
 * is the thing that is broken — so `yantra browser use system --path P` asks
 * only "is this a binary I could run?" and leaves "does it work?" to
 * `yantra browser check`.
 *
 * Each failure is its own reason with its own message: two failures sharing a
 * code that read identically send the user looking for the wrong thing.
 */

import { access, constants, lstat, stat } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';

/** Closed set of reasons a custom path cannot be selected. */
export type SelectionValidationReason =
  | 'not-absolute'
  | 'empty'
  | 'missing'
  | 'not-a-file'
  | 'unreadable'
  | 'not-executable';

export interface SelectionValidationFailure {
  readonly status: 'invalid';
  readonly reason: SelectionValidationReason;
  readonly detail: string;
  readonly remediation: string;
}

export type SelectionValidation =
  | { readonly status: 'valid'; readonly executablePath: string }
  | SelectionValidationFailure;

const ABSOLUTE_HINT =
  'Pass `--path` an absolute path to a Chrome or Chromium executable, for example `/opt/google/chrome/chrome`.';

export interface SelectionValidationDeps {
  /** Filesystem boundary, injected so every reason is reachable in tests. */
  readonly lstat?: typeof lstat;
  readonly stat?: typeof stat;
  readonly access?: typeof access;
  readonly platform?: NodeJS.Platform;
}

/**
 * Validates that a path names a runnable binary.
 *
 * A symlink is followed — a distribution that ships `/usr/bin/google-chrome` as
 * a link to the real binary is an ordinary, valid selection — but the target
 * still has to be a regular file.
 *
 * On Windows the executable bit is not a meaningful permission, so readability
 * is the strongest check available there; asking for `X_OK` would refuse every
 * real `chrome.exe`.
 */
export async function validateSelectablePath(
  candidate: string,
  deps: SelectionValidationDeps = {},
): Promise<SelectionValidation> {
  const statFn = deps.stat ?? stat;
  const lstatFn = deps.lstat ?? lstat;
  const accessFn = deps.access ?? access;
  const platform = deps.platform ?? process.platform;

  const path = candidate.trim();
  if (path.length === 0) {
    return {
      status: 'invalid',
      reason: 'empty',
      detail: 'No executable path was supplied.',
      remediation: ABSOLUTE_HINT,
    };
  }
  if (!isAbsolute(path) && !win32.isAbsolute(path)) {
    return {
      status: 'invalid',
      reason: 'not-absolute',
      detail: `The browser path "${path}" is relative.`,
      remediation: ABSOLUTE_HINT,
    };
  }

  // `lstat` first so a dangling symlink is reported as missing rather than as
  // an unreadable file.
  try {
    await lstatFn(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'invalid',
        reason: 'missing',
        detail: `No file exists at ${path}.`,
        remediation:
          'Check the path, or run `yantra browser list` to see the browsers Yantra can find.',
      };
    }
    return unreadable(path, error);
  }

  let info;
  try {
    info = await statFn(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'invalid',
        reason: 'missing',
        detail: `The browser path ${path} is a symbolic link whose target does not exist.`,
        remediation: 'Point `--path` at the real executable, or repair the link.',
      };
    }
    return unreadable(path, error);
  }

  if (info.isDirectory()) {
    return {
      status: 'invalid',
      reason: 'not-a-file',
      detail: `${path} is a directory, not a browser executable.`,
      remediation:
        platform === 'darwin'
          ? 'On macOS the executable is inside the bundle, for example `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.'
          : ABSOLUTE_HINT,
    };
  }
  if (!info.isFile()) {
    return {
      status: 'invalid',
      reason: 'not-a-file',
      detail: `${path} is not a regular file.`,
      remediation: ABSOLUTE_HINT,
    };
  }

  try {
    await accessFn(path, constants.R_OK);
  } catch (error) {
    return unreadable(path, error);
  }

  // The executable bit is a POSIX concept; on Windows a readable `.exe` is as
  // far as a non-launching check can go.
  if (platform !== 'win32') {
    try {
      await accessFn(path, constants.X_OK);
    } catch {
      return {
        status: 'invalid',
        reason: 'not-executable',
        detail: `${path} is not executable by this user.`,
        remediation: `Grant execute permission (for example \`chmod +x ${path}\`) or select a different browser.`,
      };
    }
  }

  return { status: 'valid', executablePath: path };
}

function unreadable(path: string, error: unknown): SelectionValidationFailure {
  return {
    status: 'invalid',
    reason: 'unreadable',
    detail: `${path} could not be read: ${error instanceof Error ? error.message : String(error)}.`,
    remediation: 'Check the file permissions, then retry.',
  };
}
