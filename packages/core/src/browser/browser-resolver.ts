/**
 * Local browser resolution.
 *
 * Resolution is read-only in the strongest sense: it never downloads, never
 * launches, and never contacts a version server. It answers one question —
 * "which executable does this selection mean, and where did that answer come
 * from" — so every browser-backed caller gets the same answer for the same
 * inputs.
 */

import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, win32 } from 'node:path';

import { detectChrome } from './chrome-discovery.js';
import { BrowserResolutionError } from './errors.js';
import {
  type BrowserResolution,
  type ExecutableIdentity,
  type BrowserResolutionErrorCode,
  type BrowserResolver,
  type BrowserSelection,
  type BrowserSelectionReader,
  type ManagedReadyRecord,
  type ManagedStateReader,
  type ResolvedBrowserInstallation,
  type SelectionOrigin,
  type SelectionReason,
} from './installation-types.js';
import { canonicalize, managedExecutablePath, LocalManagedStateReader } from './managed-state.js';
import { managedBrowsersRoot } from './paths.js';
import type { ChromeInstall } from './types.js';

/** The selection used when neither the invocation nor config chose one. */
export const DEFAULT_BROWSER_SELECTION: BrowserSelection = Object.freeze({
  source: 'auto',
  executablePath: null,
});

/** A reader that reports "no configured selection" — the default until FEAT-045. */
export const NO_CONFIGURED_SELECTION: BrowserSelectionReader = Object.freeze({
  read: () => Promise.resolve(undefined),
});

export interface BrowserResolverDeps {
  /** Persisted selection. Defaults to "none configured". */
  readonly selectionReader?: BrowserSelectionReader;
  readonly managedState?: ManagedStateReader;
  /** External discovery / version probing boundary. Never launches Chrome. */
  readonly discover?: (opts?: { readonly override?: string }) => ChromeInstall | null;
  readonly managedRoot?: () => string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  /** Whether managed builds exist for this host. Wired to the driver descriptor. */
  readonly supportedHost?: (platform: NodeJS.Platform, arch: string) => boolean;
}

const INSTALL_HINT =
  'Run `yantra browser install` to install the managed Chrome for Testing build.';
const SYSTEM_HINT =
  'Install Chrome or Chromium, or run `yantra browser install` to use a Yantra-managed build.';

function fail(
  code: BrowserResolutionErrorCode,
  message: string,
  requestedSelection: BrowserSelection,
  remediation: string,
  evidence: Readonly<Record<string, unknown>> = {},
): BrowserResolution {
  return {
    status: 'unavailable',
    error: new BrowserResolutionError({
      code,
      message,
      requestedSelection,
      remediation,
      evidence,
    }),
  };
}

/** Lexical containment — deliberately *not* symlink-aware; see {@link isEscape}. */
function isLexicallyInside(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel) && !win32.isAbsolute(rel);
}

/** Filesystem-backed {@link BrowserResolver}. */
export class LocalBrowserResolver implements BrowserResolver {
  private readonly selectionReader: BrowserSelectionReader;
  private readonly managedState: ManagedStateReader;
  private readonly discover: (opts?: { readonly override?: string }) => ChromeInstall | null;
  private readonly managedRoot: () => string;
  private readonly platform: NodeJS.Platform;
  private readonly architecture: string;
  private readonly supportedHost: (platform: NodeJS.Platform, arch: string) => boolean;

  constructor(deps: BrowserResolverDeps = {}) {
    this.selectionReader = deps.selectionReader ?? NO_CONFIGURED_SELECTION;
    this.managedState = deps.managedState ?? new LocalManagedStateReader();
    this.discover = deps.discover ?? detectChrome;
    this.managedRoot = deps.managedRoot ?? managedBrowsersRoot;
    this.platform = deps.platform ?? process.platform;
    this.architecture = deps.architecture ?? process.arch;
    this.supportedHost = deps.supportedHost ?? (() => true);
  }

  /** @inheritdoc */
  async resolve(override?: BrowserSelection): Promise<BrowserResolution> {
    // Precedence is whole-selection, never a field-by-field merge: an
    // invocation `system` with a null path therefore *clears* a configured
    // custom path rather than inheriting it.
    let selection: BrowserSelection;
    let origin: SelectionOrigin;
    if (override !== undefined) {
      selection = override;
      origin = 'invocation';
    } else {
      const configured = await this.selectionReader.read();
      if (configured !== undefined) {
        selection = configured;
        origin = 'config';
      } else {
        selection = DEFAULT_BROWSER_SELECTION;
        origin = 'default';
      }
    }

    const invalid = validateSelection(selection);
    if (invalid !== null) {
      return fail(
        'invalid-selection',
        invalid,
        selection,
        'Use `--browser auto|managed|system`, and `--browser-path` only with `system`.',
      );
    }

    switch (selection.source) {
      case 'managed':
        return this.resolveManaged(selection, origin, 'managed-explicit');
      case 'system':
        return selection.executablePath === null
          ? this.resolveExternal(selection, origin, 'system-discovery')
          : this.resolveCustomPath(selection, origin, selection.executablePath);
      case 'auto':
      default:
        return this.resolveAuto(selection, origin);
    }
  }

  /**
   * Automatic selection prefers a ready managed installation.
   *
   * A *corrupt* managed pointer fails closed instead of falling through to
   * external Chrome: silently running a different browser than the one the
   * machine is set up around is exactly the behavior this feature removes.
   */
  private async resolveAuto(
    selection: BrowserSelection,
    origin: SelectionOrigin,
  ): Promise<BrowserResolution> {
    const ready = await this.managedState.readReady();
    if (ready.status === 'invalid') {
      return fail(
        'managed-state-invalid',
        `The Yantra-managed browser record is unusable: ${ready.reason}.`,
        selection,
        INSTALL_HINT,
        { readyReason: ready.reason },
      );
    }
    if (ready.status === 'ready') {
      return this.buildManaged(selection, origin, 'managed-preferred', ready.record);
    }
    return this.resolveExternal(selection, origin, 'system-discovery');
  }

  private async resolveManaged(
    selection: BrowserSelection,
    origin: SelectionOrigin,
    reason: SelectionReason,
  ): Promise<BrowserResolution> {
    if (!this.supportedHost(this.platform, this.architecture)) {
      return fail(
        'unsupported-platform',
        `Chrome for Testing publishes no managed build for ${this.platform}/${this.architecture}.`,
        selection,
        'Install Chrome or Chromium and run `yantra browser use system`.',
        { platform: this.platform, architecture: this.architecture },
      );
    }
    const ready = await this.managedState.readReady();
    if (ready.status === 'absent') {
      return fail('missing', 'No Yantra-managed browser is installed.', selection, INSTALL_HINT, {
        managedRoot: this.managedRoot(),
      });
    }
    if (ready.status === 'invalid') {
      return fail(
        'managed-state-invalid',
        `The Yantra-managed browser record is unusable: ${ready.reason}.`,
        selection,
        INSTALL_HINT,
        { readyReason: ready.reason },
      );
    }
    return this.buildManaged(selection, origin, reason, ready.record);
  }

  private async buildManaged(
    selection: BrowserSelection,
    origin: SelectionOrigin,
    reason: SelectionReason,
    record: ManagedReadyRecord,
  ): Promise<BrowserResolution> {
    const root = this.managedRoot();
    const { path: executablePath, agrees } = managedExecutablePath(record, root);
    if (!agrees) {
      return fail(
        'managed-state-invalid',
        'The managed ready record does not agree with the on-disk installation layout.',
        selection,
        INSTALL_HINT,
        { recordedExecutable: record.executableRelative, buildId: record.buildId },
      );
    }

    const identity = await this.identify(executablePath);
    if (identity.kind === 'absent') {
      return fail(
        'managed-state-invalid',
        `The managed browser executable is missing at the recorded location.`,
        selection,
        INSTALL_HINT,
        { executablePath },
      );
    }
    if (identity.kind === 'unreadable') {
      return fail(
        'invalid-executable',
        `The managed browser executable could not be identified: ${identity.reason}.`,
        selection,
        INSTALL_HINT,
        { executablePath },
      );
    }

    return {
      status: 'resolved',
      installation: {
        ...identity.identity,
        ownership: 'managed',
        requestedSelection: selection,
        selectionOrigin: origin,
        selectionReason: reason,
        channel: 'stable',
        managedIdentity: record,
      },
    };
  }

  private async resolveExternal(
    selection: BrowserSelection,
    origin: SelectionOrigin,
    reason: SelectionReason,
  ): Promise<BrowserResolution> {
    const discovered = this.discover();
    if (!discovered) {
      return fail(
        'missing',
        'No Chrome or Chromium installation was found.',
        selection,
        SYSTEM_HINT,
        {
          platform: this.platform,
        },
      );
    }
    const identity = await this.identify(discovered.path, discovered);
    if (identity.kind !== 'identified') {
      return fail(
        'invalid-executable',
        `The discovered browser at ${discovered.path} could not be identified.`,
        selection,
        SYSTEM_HINT,
        { executablePath: discovered.path },
      );
    }
    return {
      status: 'resolved',
      installation: {
        ...identity.identity,
        ownership: 'external',
        requestedSelection: selection,
        selectionOrigin: origin,
        selectionReason: reason,
        channel: discovered.channel,
        managedIdentity: null,
      },
    };
  }

  /**
   * Resolve an explicit absolute executable.
   *
   * Ownership is decided canonically, not by how the caller spelled it: a
   * custom path that lands inside the managed root is managed-owned even when
   * it arrived through `system`, and therefore has to be the exact ready
   * executable and obey managed coordination.
   */
  private async resolveCustomPath(
    selection: BrowserSelection,
    origin: SelectionOrigin,
    executablePath: string,
  ): Promise<BrowserResolution> {
    const root = this.managedRoot();
    const canonical = await canonicalize(executablePath);
    if (canonical === null) {
      return fail(
        'missing',
        `No executable exists at ${executablePath}.`,
        selection,
        'Pass `--browser-path` an absolute path to an existing Chrome or Chromium binary.',
        { executablePath },
      );
    }

    const lexicalInside = isLexicallyInside(executablePath, root);
    const canonicalInside = isLexicallyInside(canonical, resolve(root));
    const canonicalRoot = await canonicalize(root);
    const trulyInside =
      canonicalInside || (canonicalRoot !== null && isLexicallyInside(canonical, canonicalRoot));

    if (lexicalInside !== trulyInside) {
      return fail(
        'invalid-selection',
        'The selected path crosses the managed browser root through a symlink or junction.',
        selection,
        'Select the executable by its real path, or use `yantra browser use managed`.',
        { executablePath, canonicalPath: canonical },
      );
    }

    if (trulyInside) {
      const ready = await this.managedState.readReady();
      if (ready.status === 'invalid') {
        return fail(
          'managed-state-invalid',
          `The Yantra-managed browser record is unusable: ${ready.reason}.`,
          selection,
          INSTALL_HINT,
          { readyReason: ready.reason },
        );
      }
      if (ready.status === 'absent') {
        return fail(
          'invalid-selection',
          'The selected path is inside the managed browser root, but no managed installation is ready.',
          selection,
          INSTALL_HINT,
          { executablePath },
        );
      }
      const expected = managedExecutablePath(ready.record, root);
      const canonicalExpected = await canonicalize(expected.path);
      if (!expected.agrees || canonicalExpected === null || canonicalExpected !== canonical) {
        return fail(
          'invalid-selection',
          'The selected path is inside the managed browser root but is not the ready installation.',
          selection,
          'Use `yantra browser use managed` to select the ready managed installation.',
          { executablePath, readyExecutable: expected.path },
        );
      }
      return this.buildManaged(selection, origin, 'custom-path', ready.record);
    }

    const identity = await this.identify(executablePath);
    if (identity.kind === 'absent') {
      return fail(
        'missing',
        `No executable exists at ${executablePath}.`,
        selection,
        'Pass `--browser-path` an absolute path to an existing Chrome or Chromium binary.',
        { executablePath },
      );
    }
    if (identity.kind === 'unreadable') {
      return fail(
        'invalid-executable',
        `The browser at ${executablePath} could not be identified: ${identity.reason}.`,
        selection,
        'Point `--browser-path` at a Chrome or Chromium executable.',
        { executablePath },
      );
    }
    const probed = this.discover({ override: executablePath });
    return {
      status: 'resolved',
      installation: {
        ...identity.identity,
        ownership: 'external',
        requestedSelection: selection,
        selectionOrigin: origin,
        selectionReason: 'custom-path',
        channel: probed?.channel ?? 'unknown',
        managedIdentity: null,
      },
    };
  }

  /** Stat and version an executable without launching it. */
  private identify(
    executablePath: string,
    prediscovered?: ChromeInstall,
  ): Promise<IdentificationOutcome> {
    return identifyExecutableDetailed(executablePath, {
      discover: this.discover,
      platform: this.platform,
      architecture: this.architecture,
      ...(prediscovered ? { prediscovered } : {}),
    });
  }
}

/** Outcome of identifying one executable, distinguishing absent from unreadable. */
export type IdentificationOutcome =
  | { readonly kind: 'identified'; readonly identity: ExecutableIdentity }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly reason: string };

export interface IdentifyDeps {
  readonly discover?: (opts?: { readonly override?: string }) => ChromeInstall | null;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly prediscovered?: ChromeInstall;
}

/**
 * Stat and version an executable without launching it.
 *
 * On Windows, discovery reads version metadata rather than running
 * `chrome.exe --version`, which prints nothing there and opens a browser window.
 */
export async function identifyExecutableDetailed(
  executablePath: string,
  deps: IdentifyDeps = {},
): Promise<IdentificationOutcome> {
  const discover = deps.discover ?? detectChrome;
  let info;
  try {
    info = await stat(executablePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', reason: (error as Error).message };
  }
  if (!info.isFile()) return { kind: 'unreadable', reason: 'not a regular file' };

  const probed = deps.prediscovered ?? discover({ override: executablePath });
  if (!probed) return { kind: 'unreadable', reason: 'version could not be read' };

  const canonical = (await canonicalize(executablePath)) ?? resolve(executablePath);
  return {
    kind: 'identified',
    identity: {
      canonicalPath: canonical,
      version: probed.version,
      majorVersion: probed.majorVersion,
      platform: deps.platform ?? process.platform,
      architecture: deps.architecture ?? process.arch,
      statFingerprint: `${info.size}:${Math.trunc(info.mtimeMs)}:${info.dev}:${info.ino}`,
    },
  };
}

/** Convenience wrapper returning the identity, or null when it cannot be read. */
export async function identifyExecutable(
  executablePath: string,
  deps: IdentifyDeps = {},
): Promise<ExecutableIdentity | null> {
  const outcome = await identifyExecutableDetailed(executablePath, deps);
  return outcome.kind === 'identified' ? outcome.identity : null;
}

/** Returns a validation message, or null when the selection is well-formed. */
export function validateSelection(selection: BrowserSelection): string | null {
  if (
    selection.source !== 'auto' &&
    selection.source !== 'managed' &&
    selection.source !== 'system'
  )
    return `unknown browser source "${String(selection.source)}"`;
  if (selection.executablePath === null) return null;
  if (selection.source !== 'system')
    return `an explicit executable path is legal only with source "system", not "${selection.source}"`;
  if (selection.executablePath.trim().length === 0) return 'the executable path must not be empty';
  if (!isAbsolute(selection.executablePath) && !win32.isAbsolute(selection.executablePath))
    return 'the executable path must be absolute';
  return null;
}

/**
 * Projects a resolved installation onto the legacy {@link ChromeInstall} shape.
 *
 * Existing session metadata and doctor output still speak `ChromeInstall`; the
 * resolved installation stays the one semantic source and this is a view of it.
 */
export function toChromeInstall(installation: ResolvedBrowserInstallation): ChromeInstall {
  return {
    path: installation.canonicalPath,
    version: installation.version,
    majorVersion: installation.majorVersion,
    channel: installation.channel,
    source: installation.ownership === 'managed' ? 'managed' : 'system',
  };
}
