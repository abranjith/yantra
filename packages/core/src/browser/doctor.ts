import { access, constants, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';

import { indexDbPath, openIndexDb, setMeta } from '../index-db/db.js';
import { SqliteHistoryStore } from '../index-db/history-store.js';

import type { BrowserRuntimeServices } from './installation-types.js';
import { LocalBrowserInventoryService, type BrowserInventory } from './inventory.js';
import { cacheDir, dataDir, doctorCachePath, profilesRoot } from './paths.js';
import { createLocalBrowserRuntimeServices } from './runtime-services.js';
import type { DoctorCheck, DoctorReport } from './types.js';

const DOCTOR_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Fingerprint field separator, written as escape notation, never a raw byte. */
const FINGERPRINT_SEPARATOR = '\u0000';

function buildCheck(
  id: DoctorCheck['id'],
  status: DoctorCheck['status'],
  message: string,
  details: DoctorCheck['details'] = {},
  fixHint: string | null = null,
): DoctorCheck {
  return { id, status, message, details, fixHint };
}

function errorCheck(id: DoctorCheck['id'], e: unknown): DoctorCheck {
  const message = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error ? (e.stack ?? '') : '';
  return buildCheck(id, 'error', message, { stack });
}

/**
 * Reports which browser a run would actually use, and where that answer came
 * from.
 *
 * Provenance comes from the one inventory projection `yantra browser list` also
 * renders, so doctor cannot disagree with what a run will do — an earlier
 * implementation had its own discovery call and could.
 */
function checkBrowserSelection(inventory: BrowserInventory): DoctorCheck {
  // Provenance comes from the resolution when there is one, because the resolver
  // is what decided whether the answer came from config or from the default; the
  // configured block is only the fallback for an unresolvable selection.
  const origin =
    inventory.effective.status === 'resolved'
      ? inventory.effective.installation.selectionOrigin === 'config'
        ? `config.yaml: ${inventory.effective.installation.requestedSelection.source}`
        : `no configured selection (default: ${inventory.effective.installation.requestedSelection.source})`
      : inventory.configured === undefined
        ? 'no configured selection (default: auto)'
        : `config.yaml: ${inventory.configured.source}`;

  if (inventory.effective.status === 'unavailable') {
    const { code, remediation, message } = inventory.effective.error;
    return buildCheck(
      'browser.selection',
      'error',
      message,
      {
        code,
        selection: inventory.configured?.source ?? 'auto',
        origin,
        alternatives: inventory.alternatives.map((entry) => entry.executablePath),
      },
      remediation,
    );
  }

  const installation = inventory.effective.installation;
  return buildCheck(
    'browser.selection',
    'ok',
    `${installation.ownership} Chrome ${installation.version} at ${installation.canonicalPath} (${origin})`,
    {
      path: installation.canonicalPath,
      version: installation.version,
      ownership: installation.ownership,
      source: installation.requestedSelection.source,
      selectionOrigin: installation.selectionOrigin,
      selectionReason: installation.selectionReason,
      alternatives: inventory.alternatives.map((entry) => entry.executablePath),
    },
  );
}

/**
 * Reports local compatibility evidence, and reports its absence honestly.
 *
 * Doctor never launches a browser to manufacture an ok result, and it no longer
 * asserts a minimum Chrome major: a build outside the tested pairing is the
 * normal case, so what matters is whether the required primitives were proved.
 * `capability-checked` is therefore reported as ordinary operation, never as a
 * standing warning.
 */
function checkBrowserCompatibility(inventory: BrowserInventory): DoctorCheck {
  if (inventory.effective.status === 'unavailable') {
    return buildCheck(
      'browser.compatibility',
      'warn',
      'No browser was selected, so no compatibility evidence applies.',
      { compatibility: 'unverified' },
      inventory.effective.error.remediation,
    );
  }

  const { installation, compatibility, recorderCompatibility } = inventory.effective;
  if (compatibility.state === 'unverified') {
    return buildCheck(
      'browser.compatibility',
      'warn',
      'This browser has not been checked on this machine yet.',
      { compatibility: 'unverified', path: installation.canonicalPath },
      'Run `yantra browser check` to test it locally.',
    );
  }

  const result = compatibility.result;
  if (result.verdict.status === 'failed') {
    const failing = result.capabilities
      .filter((row) => row.status === 'failed')
      .map((row) => row.capability);
    return buildCheck(
      'browser.compatibility',
      'error',
      `Chrome ${result.identity.version} failed required capabilities: ${failing.join(', ')}.`,
      { compatibility: 'failed', failing, failureClass: result.verdict.failureClass },
      result.verdict.remediation,
    );
  }

  // Evidence describing a *different* build than the one now selected is stale,
  // not ok: the cache key covers identity, so this can only happen if the
  // selection moved between the probe and this report.
  const stale = result.identity.canonicalPath !== installation.canonicalPath;
  const recorder =
    recorderCompatibility.state === 'evidence' &&
    recorderCompatibility.result.verdict.status === 'passed'
      ? recorderCompatibility.result.verdict.pairing
      : 'unverified';

  return buildCheck(
    'browser.compatibility',
    stale ? 'warn' : 'ok',
    stale
      ? `The local compatibility evidence describes ${result.identity.canonicalPath}, not the currently selected browser.`
      : `Chrome ${result.identity.version} passed every required capability (${result.verdict.pairing}, tested against ${result.testedBuild}).`,
    {
      compatibility: stale ? 'stale' : 'passed',
      pairing: result.verdict.pairing,
      recorderCompatibility: recorder,
      testedBuild: result.testedBuild,
      driverVersion: result.driverVersion,
      checkedAt: result.checkedAt,
    },
    stale ? 'Run `yantra browser check` to re-test the selected browser.' : null,
  );
}

/**
 * Reports the managed installation and what could be reclaimed.
 *
 * Read-only: doctor never installs, never collects orphans, and never repairs by
 * downloading. Explicit `browser install` / `browser update` do the collecting.
 */
function checkManagedBrowser(inventory: BrowserInventory): DoctorCheck {
  const details = {
    managedRoot: inventory.managedRoot,
    orphanCount: inventory.orphans.count,
    reclaimableBytes: inventory.orphans.reclaimableBytes,
  };
  const reclaimable =
    inventory.orphans.count === 0
      ? ''
      : ` ${inventory.orphans.count} superseded installation(s) hold ${inventory.orphans.reclaimableBytes} bytes.`;

  if (inventory.managed.status === 'invalid') {
    return buildCheck(
      'browser.managed',
      'error',
      `The Yantra-managed browser record is unusable: ${inventory.managed.reason}.${reclaimable}`,
      { ...details, status: 'invalid', reason: inventory.managed.reason },
      'Run `yantra browser install` to reinstall the managed Chrome for Testing build.',
    );
  }
  if (inventory.managed.status === 'absent') {
    return buildCheck(
      'browser.managed',
      'ok',
      `No Yantra-managed browser is installed; ${inventory.managedRoot} holds no ready build.${reclaimable}`,
      { ...details, status: 'absent' },
      // Absent is not a problem when an external browser resolves, so this is a
      // pointer rather than a remediation for a failure.
      inventory.effective.status === 'resolved'
        ? null
        : 'Run `yantra browser install` to install a Yantra-managed Chrome.',
    );
  }
  return buildCheck(
    'browser.managed',
    'ok',
    `Managed Chrome for Testing ${inventory.managed.record.buildId} under ${inventory.managedRoot}.${reclaimable}`,
    { ...details, status: 'ready', buildId: inventory.managed.record.buildId },
  );
}

async function checkDirWritable(id: DoctorCheck['id'], dirPath: string): Promise<DoctorCheck> {
  try {
    try {
      await access(dirPath, constants.W_OK);
    } catch {
      // Try to create if missing
      await mkdir(dirPath, { recursive: true, mode: 0o700 });
      await access(dirPath, constants.W_OK);
    }
    return buildCheck(id, 'ok', `${dirPath} is writable.`, { path: dirPath });
  } catch (e) {
    return buildCheck(id, 'error', `${dirPath} is not writable: ${(e as Error).message}`, {
      path: dirPath,
    });
  }
}

async function checkDataDirPermissions(): Promise<DoctorCheck> {
  try {
    if (process.platform === 'win32') {
      return buildCheck(
        'datadir.permissions',
        'ok',
        'Directory permission enforcement is best-effort on Windows.',
        { note: 'owner-only ACL not enforced on Windows in v0' },
      );
    }

    const dirPath = dataDir();
    const offenders: string[] = [];

    // Check the data root and profiles root
    for (const p of [dirPath, profilesRoot()]) {
      try {
        const info = await stat(p);
        const mode = info.mode & 0o777;
        if (mode & 0o077) offenders.push(p);
      } catch {
        // dir may not exist yet — skip
      }
    }

    // Walk per-workflow profile subdirs
    try {
      const profileDirs = await readdir(profilesRoot());
      for (const name of profileDirs) {
        const p = `${profilesRoot()}/${name}`;
        try {
          const info = await stat(p);
          if (info.isDirectory()) {
            const mode = info.mode & 0o777;
            if (mode & 0o077) offenders.push(p);
          }
        } catch {
          // skip
        }
      }
    } catch {
      // profiles root may not exist
    }

    if (offenders.length > 0) {
      return buildCheck(
        'datadir.permissions',
        'warn',
        `Some Yantra directories have group/other permissions. Expected mode 0700.`,
        { offenders },
        'Run: chmod 700 ' + offenders.join(' '),
      );
    }

    return buildCheck('datadir.permissions', 'ok', 'Data directory permissions are 0700.', {});
  } catch (e) {
    return errorCheck('datadir.permissions', e);
  }
}

async function checkKeychainReachable(): Promise<DoctorCheck> {
  const probeService = 'yantra-doctor';
  const probeAccount = 'probe';
  const probeValue = 'ok';

  interface KeytarApi {
    setPassword(svc: string, acct: string, pass: string): Promise<void>;
    getPassword(svc: string, acct: string): Promise<string | null>;
    deletePassword(svc: string, acct: string): Promise<boolean>;
  }

  try {
    // Dynamic import so that keytar unavailability returns an error check, not a crash
    const mod = await import('keytar').catch(() => null);
    if (!mod) {
      return buildCheck(
        'keychain.reachable',
        'error',
        'keytar module is not available. Secrets cannot be stored.',
        { reason: 'keytar not installed or native binding missing' },
        'Ensure keytar is installed: pnpm add keytar',
      );
    }

    // keytar is a CJS module; ESM dynamic import wraps module.exports under .default
    const keytar = (mod as { default?: KeytarApi }).default ?? mod;

    await keytar.setPassword(probeService, probeAccount, probeValue);
    const readBack = await keytar.getPassword(probeService, probeAccount);
    await keytar.deletePassword(probeService, probeAccount);

    if (readBack !== probeValue) {
      return buildCheck(
        'keychain.reachable',
        'error',
        'Keychain round-trip failed: stored value did not match.',
        { expected: probeValue, got: readBack },
      );
    }

    return buildCheck(
      'keychain.reachable',
      'ok',
      'Keychain is reachable (probe round-trip succeeded).',
      {},
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return buildCheck(
      'keychain.reachable',
      'error',
      `Keychain probe failed: ${message}`,
      { error: message },
      'macOS: unlock keychain. Linux: install libsecret + gnome-keyring. Windows: should work out of the box.',
    );
  }
}

/**
 * Verifies the local SQLite index opens, migrates, and accepts a write. Because
 * the index is a rebuildable cache (plan §7), a corrupt file is not an error:
 * {@link openIndexDb} moves it aside and rebuilds `history` from the run tree,
 * and this check reports a `warn` so the user sees it happened.
 */
async function checkIndexDbWritable(): Promise<DoctorCheck> {
  const path = indexDbPath();
  try {
    const { db, wasCorrupt } = await openIndexDb({
      rebuild: async (fresh) => {
        const store = new SqliteHistoryStore({ db: fresh });
        await store.rebuildFromRuns();
      },
    });
    try {
      // Probe write — a read-only DB (bad perms) throws here.
      setMeta(db, 'doctor_probe_at', new Date().toISOString());
    } finally {
      db.close();
    }

    if (wasCorrupt) {
      return buildCheck(
        'indexdb.writable',
        'warn',
        'index.db was corrupt and has been rebuilt from the run history.',
        { path },
        'No action needed — the index is a rebuildable cache of your runs.',
      );
    }
    return buildCheck('indexdb.writable', 'ok', `${path} is writable.`, { path });
  } catch (e) {
    return buildCheck(
      'indexdb.writable',
      'error',
      `index.db is not writable: ${(e as Error).message}`,
      { path },
      'Check permissions on the Yantra data directory (expected owner-only 0700/0600).',
    );
  }
}

function rollupOverall(checks: readonly DoctorCheck[]): DoctorReport['overall'] {
  if (checks.some((c) => c.status === 'error')) return 'error';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

/** Reads the shared inventory, tolerating a services bag built by hand. */
function readInventory(services: BrowserRuntimeServices): Promise<BrowserInventory> {
  if (services.inventory !== undefined) return services.inventory.read();
  return new LocalBrowserInventoryService({
    resolver: services.resolver,
    managedState: services.managedState,
    compatibility: services.compatibility,
  }).read();
}

async function runAllChecks(services: BrowserRuntimeServices): Promise<readonly DoctorCheck[]> {
  // One read-only inventory read, shared by all three browser checks — the same
  // projection `yantra browser list` renders. No launch, no probe, no network,
  // no orphan collection: doctor reports what is there, it does not repair it.
  // A failure here is reported as a failed browser check, never allowed to take
  // the rest of the report down with it.
  let inventory: BrowserInventory | null = null;
  let inventoryFailure: unknown = null;
  try {
    inventory = await readInventory(services);
  } catch (error) {
    inventoryFailure = error;
  }

  const browserChecks =
    inventory === null
      ? [
          errorCheck('browser.selection', inventoryFailure),
          buildCheck(
            'browser.compatibility',
            'warn',
            'No browser was resolved, so no compatibility evidence applies.',
            { compatibility: 'unverified' },
          ),
          errorCheck('browser.managed', inventoryFailure),
        ]
      : [
          checkBrowserSelection(inventory),
          checkBrowserCompatibility(inventory),
          checkManagedBrowser(inventory),
        ];

  const dataDirCheck = await checkDirWritable('datadir.writable', dataDir());
  const dataPermsCheck = await checkDataDirPermissions();
  const cacheDirCheck = await checkDirWritable('cachedir.writable', cacheDir());
  const keychainCheck = await checkKeychainReachable();
  const indexDbCheck = await checkIndexDbWritable();

  return [
    ...browserChecks,
    dataDirCheck,
    dataPermsCheck,
    cacheDirCheck,
    keychainCheck,
    indexDbCheck,
  ];
}

/**
 * Runs Yantra environment diagnostics. Never throws — always returns a DoctorReport.
 * Results are cached for 1 hour in ~/.yantra/cache/doctor.json.
 *
 * @param opts.refresh - Force a fresh check, bypassing the cache.
 * @example
 * const report = await doctor();
 * if (report.overall !== 'ok') console.error('Environment has issues!');
 */
export async function doctor(opts?: {
  readonly refresh?: boolean;
  /** Injected for tests; defaults to the local read-only services. */
  readonly services?: BrowserRuntimeServices;
}): Promise<DoctorReport> {
  const now = new Date();

  const services = opts?.services ?? createLocalBrowserRuntimeServices();

  // The browser identity is part of the cache key, so changing the selection
  // invalidates stale output *by construction* rather than by the user
  // remembering `--refresh`. Computing it costs one local inventory read and no
  // launch, so it is cheap enough to pay before serving from cache.
  const fingerprint = await browserFingerprint(services);

  if (!opts?.refresh) {
    try {
      const raw = await readFile(doctorCachePath(), 'utf8');
      const cached = JSON.parse(raw) as CachedDoctorReport;
      const generatedAt = new Date(cached.generatedAt);
      if (
        cached.browserFingerprint === fingerprint &&
        now.getTime() - generatedAt.getTime() < DOCTOR_CACHE_TTL_MS
      ) {
        const { browserFingerprint: _ignored, ...report } = cached;
        return { ...report, cachedFrom: cached.generatedAt };
      }
    } catch {
      // Cache miss or parse failure — run fresh
    }
  }

  // Run all checks, wrapping each in a top-level safety net
  const checks = await (async () => {
    try {
      return await runAllChecks(services);
    } catch (e) {
      return [errorCheck('browser.selection', e)];
    }
  })();

  const report: DoctorReport = {
    generatedAt: now.toISOString(),
    cachedFrom: null,
    overall: rollupOverall(checks),
    checks,
  };

  // Write cache — degrade gracefully on write failure
  try {
    const cacheFilePath = doctorCachePath();
    // Ensure cache dir exists
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(cacheFilePath, JSON.stringify({ ...report, browserFingerprint: fingerprint }), {
      mode: 0o600,
    });
  } catch {
    // Cache write failure is non-fatal — return the fresh report without caching
  }

  return report;
}

/** The cached report plus the browser identity it describes. */
interface CachedDoctorReport extends DoctorReport {
  readonly browserFingerprint?: string;
}

/**
 * Identity of the browser this report would describe.
 *
 * Covers the configured selection, the canonical executable, its version and
 * stat fingerprint, and the managed ready pointer — every input that can change
 * what the browser checks say. An unreadable inventory yields a distinct
 * fingerprint so a failing report is never served for a fixed machine.
 */
async function browserFingerprint(services: BrowserRuntimeServices): Promise<string> {
  let inventory: BrowserInventory;
  try {
    inventory = await readInventory(services);
  } catch {
    return 'inventory-unreadable';
  }
  const configured = inventory.configured;
  const effective =
    inventory.effective.status === 'resolved'
      ? [
          inventory.effective.installation.canonicalPath,
          inventory.effective.installation.version,
          inventory.effective.installation.statFingerprint,
          inventory.effective.compatibility.state,
        ]
      : ['unavailable', inventory.effective.error.code];
  const managed =
    inventory.managed.status === 'ready'
      ? inventory.managed.record.installationId
      : inventory.managed.status;

  return [
    configured?.source ?? 'none',
    configured?.executablePath ?? 'null',
    ...effective,
    managed,
    String(inventory.orphans.count),
  ].join(FINGERPRINT_SEPARATOR);
}
