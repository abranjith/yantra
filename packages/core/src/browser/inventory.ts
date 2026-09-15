/**
 * The one local browser inventory projection.
 *
 * `yantra browser list` and `yantra doctor` render the same object, so the two
 * surfaces cannot disagree about which browser a run will actually use — the
 * previous doctor implementation had its own discovery call and could.
 *
 * `read()` is local and side-effect free in the strongest sense: it launches no
 * browser, installs nothing, collects no orphans, and opens no socket. It
 * composes the resolver's provenance, the managed state reader's inventory,
 * cached compatibility evidence, and the existing external discovery — it adds
 * no discovery implementation of its own.
 */

import { detectChrome } from './chrome-discovery.js';
import { DRIVER_COMPATIBILITY } from './driver-compatibility.js';
import type {
  BrowserResolution,
  BrowserResolutionErrorLike,
  BrowserResolver,
  BrowserSelection,
  BrowserSelectionReader,
  CompatibilityEvidenceState,
  DriverCompatibilityDescriptor,
  ManagedInventory,
  ManagedReadySnapshot,
  ProbeProfile,
  ResolvedBrowserInstallation,
} from './installation-types.js';
import { managedBrowsersRoot } from './paths.js';
import type { ChromeInstall } from './types.js';

/** One browser the machine has, as the inventory renders it. */
export interface BrowserInventoryEntry {
  readonly ownership: 'managed' | 'external';
  readonly executablePath: string;
  /** Null when the binary could not be interrogated without launching it. */
  readonly version: string | null;
  readonly channel: ResolvedBrowserInstallation['channel'];
  /** Exactly one entry is true when `effective.status` is `resolved`. */
  readonly isEffective: boolean;
}

export interface BrowserInventory {
  /** Undefined when `config.yaml` carries no `browser:` block. */
  readonly configured: BrowserSelection | undefined;
  /** Present only on launch-capable commands that accept `--browser`. */
  readonly override: BrowserSelection | undefined;
  readonly effective:
    | {
        readonly status: 'resolved';
        readonly installation: ResolvedBrowserInstallation;
        readonly compatibility: CompatibilityEvidenceState;
        /** Recorder evidence, named separately when it differs from automation. */
        readonly recorderCompatibility: CompatibilityEvidenceState;
      }
    | { readonly status: 'unavailable'; readonly error: BrowserResolutionErrorLike };
  readonly managed: ManagedReadySnapshot;
  /** Discovered external binaries, plus the managed one when it is effective. */
  readonly alternatives: readonly BrowserInventoryEntry[];
  readonly orphans: { readonly count: number; readonly reclaimableBytes: number };
  readonly managedRoot: string;
  readonly driver: { readonly version: string; readonly testedBuild: string };
}

export interface BrowserInventoryService {
  read(override?: BrowserSelection): Promise<BrowserInventory>;
}

/** Reads cached evidence without launching. */
interface CachedEvidenceReader {
  readCached(
    installation: ResolvedBrowserInstallation,
    profile: ProbeProfile,
  ): Promise<CompatibilityEvidenceState>;
}

export interface BrowserInventoryDeps {
  readonly resolver: BrowserResolver;
  readonly managedState: { readInventory(): Promise<ManagedInventory> };
  readonly compatibility: CachedEvidenceReader;
  /** The persisted selection, so `list` can distinguish config from default. */
  readonly selectionReader?: BrowserSelectionReader;
  /**
   * Existing external discovery, wrapped as a list.
   *
   * Discovery returns the first usable external browser, so this is normally
   * zero or one entry; the shape is a list because the view model is, and
   * because a test needs to drive the deduplication rule.
   */
  readonly discoverExternals?: () => readonly ChromeInstall[];
  readonly managedRoot?: () => string;
  readonly descriptor?: DriverCompatibilityDescriptor;
}

/** Local, read-only {@link BrowserInventoryService}. */
export class LocalBrowserInventoryService implements BrowserInventoryService {
  private readonly resolver: BrowserResolver;
  private readonly managedState: { readInventory(): Promise<ManagedInventory> };
  private readonly compatibility: CachedEvidenceReader;
  private readonly selectionReader: BrowserSelectionReader | undefined;
  private readonly discoverExternals: () => readonly ChromeInstall[];
  private readonly managedRoot: () => string;
  private readonly descriptor: DriverCompatibilityDescriptor;

  constructor(deps: BrowserInventoryDeps) {
    this.resolver = deps.resolver;
    this.managedState = deps.managedState;
    this.compatibility = deps.compatibility;
    this.selectionReader = deps.selectionReader;
    this.discoverExternals = deps.discoverExternals ?? defaultDiscoverExternals;
    this.managedRoot = deps.managedRoot ?? managedBrowsersRoot;
    this.descriptor = deps.descriptor ?? DRIVER_COMPATIBILITY;
  }

  /** @inheritdoc */
  async read(override?: BrowserSelection): Promise<BrowserInventory> {
    const root = this.managedRoot();
    const [resolution, managedInventory, configured] = await Promise.all([
      this.resolver.resolve(override),
      this.managedState.readInventory(),
      this.readConfigured(),
    ]);

    const effective = await this.describeEffective(resolution);
    const alternatives = buildAlternatives(this.discoverExternals(), resolution);

    return {
      configured,
      override,
      effective,
      managed: managedInventory.ready,
      alternatives,
      orphans: {
        count: managedInventory.orphans.length,
        reclaimableBytes: managedInventory.orphans.reduce((total, one) => total + one.bytes, 0),
      },
      managedRoot: root,
      driver: {
        version: this.descriptor.driverVersion,
        testedBuild: this.descriptor.testedBuild,
      },
    };
  }

  /**
   * A configuration failure is reported as an absent selection rather than
   * thrown: `browser list` and `doctor` exist to *diagnose* a broken machine, so
   * neither may be taken down by the state it is describing. The failure is
   * still visible — the resolver surfaces it through `effective`.
   */
  private async readConfigured(): Promise<BrowserSelection | undefined> {
    if (this.selectionReader === undefined) return undefined;
    return this.selectionReader.read().catch(() => undefined);
  }

  private async describeEffective(
    resolution: BrowserResolution,
  ): Promise<BrowserInventory['effective']> {
    if (resolution.status === 'unavailable') {
      return { status: 'unavailable', error: resolution.error };
    }
    const installation = resolution.installation;
    const unverified = (): CompatibilityEvidenceState => ({ state: 'unverified' });
    const [compatibility, recorderCompatibility] = await Promise.all([
      this.compatibility.readCached(installation, 'automation').catch(unverified),
      this.compatibility.readCached(installation, 'recorder').catch(unverified),
    ]);
    return { status: 'resolved', installation, compatibility, recorderCompatibility };
  }
}

/** The existing single-result discovery, expressed as the list the view wants. */
function defaultDiscoverExternals(): readonly ChromeInstall[] {
  const found = detectChrome();
  return found === null ? [] : [found];
}

/**
 * Builds the alternatives list, listing each canonical path exactly once.
 *
 * A ready managed installation that external discovery also happens to find
 * (a custom `PATH` entry pointing into the managed tree, say) is one browser
 * with one entry, not two rows the user has to reconcile.
 */
function buildAlternatives(
  externals: readonly ChromeInstall[],
  resolution: BrowserResolution,
): readonly BrowserInventoryEntry[] {
  const effectivePath =
    resolution.status === 'resolved' ? canonicalKey(resolution.installation.canonicalPath) : null;

  const entries: BrowserInventoryEntry[] = [];
  const seen = new Set<string>();

  if (resolution.status === 'resolved') {
    const installation = resolution.installation;
    seen.add(canonicalKey(installation.canonicalPath));
    entries.push({
      ownership: installation.ownership,
      executablePath: installation.canonicalPath,
      version: installation.version,
      channel: installation.channel,
      isEffective: true,
    });
  }

  for (const external of externals) {
    const key = canonicalKey(external.path);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      ownership: external.source === 'managed' ? 'managed' : 'external',
      executablePath: external.path,
      version: external.version,
      channel: external.channel,
      isEffective: effectivePath === key,
    });
  }

  return entries;
}

/** Case-insensitive on Windows, where two spellings name one binary. */
function canonicalKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}
