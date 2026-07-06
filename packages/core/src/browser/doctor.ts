import { access, constants, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';

import { indexDbPath, openIndexDb, setMeta } from '../index-db/db.js';
import { SqliteHistoryStore } from '../index-db/history-store.js';

import { detectChrome } from './chrome-discovery.js';
import { MIN_SUPPORTED_CHROME_MAJOR } from './launch-options.js';
import { cacheDir, dataDir, doctorCachePath, profilesRoot } from './paths.js';
import type { DoctorCheck, DoctorReport } from './types.js';

const DOCTOR_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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

function checkChromeDetected(): DoctorCheck {
  try {
    const chrome = detectChrome();
    if (!chrome) {
      return buildCheck(
        'chrome.detected',
        'error',
        'Chrome not found on this system.',
        { os: process.platform },
        'Install Chrome from https://www.google.com/chrome/',
      );
    }
    return buildCheck('chrome.detected', 'ok', `Chrome ${chrome.version} found at ${chrome.path}`, {
      path: chrome.path,
      version: chrome.version,
    });
  } catch (e) {
    return errorCheck('chrome.detected', e);
  }
}

function checkChromeVersionMin(detectedCheck: DoctorCheck): DoctorCheck {
  try {
    if (detectedCheck.status === 'error') {
      return buildCheck(
        'chrome.version_min',
        'warn',
        'Chrome was not detected; cannot check minimum version.',
        {},
      );
    }
    const chrome = detectChrome();
    if (!chrome) {
      return buildCheck(
        'chrome.version_min',
        'warn',
        'Chrome not available for version check.',
        {},
      );
    }
    if (chrome.majorVersion < MIN_SUPPORTED_CHROME_MAJOR) {
      return buildCheck(
        'chrome.version_min',
        'error',
        `Chrome ${chrome.majorVersion} is below the minimum required version ${MIN_SUPPORTED_CHROME_MAJOR}.`,
        { found: chrome.majorVersion, required: MIN_SUPPORTED_CHROME_MAJOR },
        `Update Chrome to version ${MIN_SUPPORTED_CHROME_MAJOR} or newer.`,
      );
    }
    return buildCheck(
      'chrome.version_min',
      'ok',
      `Chrome ${chrome.majorVersion} meets minimum version ${MIN_SUPPORTED_CHROME_MAJOR}.`,
      {
        found: chrome.majorVersion,
        required: MIN_SUPPORTED_CHROME_MAJOR,
      },
    );
  } catch (e) {
    return errorCheck('chrome.version_min', e);
  }
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

async function runAllChecks(): Promise<readonly DoctorCheck[]> {
  const chromeCheck = checkChromeDetected();
  const versionCheck = checkChromeVersionMin(chromeCheck);
  const dataDirCheck = await checkDirWritable('datadir.writable', dataDir());
  const dataPermsCheck = await checkDataDirPermissions();
  const cacheDirCheck = await checkDirWritable('cachedir.writable', cacheDir());
  const keychainCheck = await checkKeychainReachable();
  const indexDbCheck = await checkIndexDbWritable();

  return [
    chromeCheck,
    versionCheck,
    dataDirCheck,
    dataPermsCheck,
    cacheDirCheck,
    keychainCheck,
    indexDbCheck,
  ];
}

/**
 * Runs Yantra environment diagnostics. Never throws — always returns a DoctorReport.
 * Results are cached for 1 hour in ~/.cache/yantra/doctor.json.
 *
 * @param opts.refresh - Force a fresh check, bypassing the cache.
 * @example
 * const report = await doctor();
 * if (report.overall !== 'ok') console.error('Environment has issues!');
 */
export async function doctor(opts?: { readonly refresh?: boolean }): Promise<DoctorReport> {
  const now = new Date();

  // Try to serve from cache
  if (!opts?.refresh) {
    try {
      const raw = await readFile(doctorCachePath(), 'utf8');
      const cached = JSON.parse(raw) as DoctorReport;
      const generatedAt = new Date(cached.generatedAt);
      if (now.getTime() - generatedAt.getTime() < DOCTOR_CACHE_TTL_MS) {
        return { ...cached, cachedFrom: cached.generatedAt };
      }
    } catch {
      // Cache miss or parse failure — run fresh
    }
  }

  // Run all checks, wrapping each in a top-level safety net
  const checks = await (async () => {
    try {
      return await runAllChecks();
    } catch (e) {
      return [errorCheck('chrome.detected', e)];
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
    await writeFile(cacheFilePath, JSON.stringify(report), { mode: 0o600 });
  } catch {
    // Cache write failure is non-fatal — return the fresh report without caching
  }

  return report;
}
