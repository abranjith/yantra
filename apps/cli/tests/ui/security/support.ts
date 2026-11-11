/**
 * A real app host process for the localhost security suite (FEAT-065
 * TASK-013): started exactly as a user does, through the built
 * `yantra ui --print --json`, on a sandboxed `YANTRA_HOME`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { HostLockRecord, UiOpenResult } from '@yantra/protocol';

import { rawRequest, type RawResponse } from '../host/support.js';

const CLI_ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const BIN = join(CLI_ROOT, 'dist', 'bin.js');

/** A host process and everything a test needs to attack it. */
export interface RealHost {
  readonly home: string;
  readonly port: number;
  readonly pid: number;
  readonly env: NodeJS.ProcessEnv;
  /** Runs `yantra ui --print --json` again and returns a fresh URL. */
  open(): UiOpenResult;
  lock(): HostLockRecord;
  dataDir(): string;
  stop(): Promise<void>;
}

/** True while `pid` exists. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Fails clearly when the CLI has not been built (the suite is a merge gate). */
export function requireBuiltCli(): void {
  if (!existsSync(BIN) || !existsSync(join(CLI_ROOT, 'dist', 'web', 'index.html'))) {
    throw new Error(
      'The security suite runs the built CLI and app. Run `pnpm build` (or `npx turbo run build --filter=@yantra/cli`) first.',
    );
  }
}

/** Starts a sandboxed host through `yantra ui --print --json`. */
export function startRealHost(extraEnv: Record<string, string> = {}): RealHost {
  requireBuiltCli();
  const home = mkdtempSync(join(tmpdir(), 'yantra-security-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    YANTRA_HOME: home,
    LLM_PROVIDER: 'none',
    ...extraEnv,
  };
  delete env.YANTRA_UI_ASSETS_DIR;
  const open = (): UiOpenResult =>
    UiOpenResult.parse(
      JSON.parse(
        execFileSync(process.execPath, [BIN, 'ui', '--print', '--json'], { env, encoding: 'utf8' }),
      ),
    );
  const first = open();
  return {
    home,
    port: first.port,
    pid: first.hostPid,
    env,
    open,
    dataDir: () => join(home, 'data'),
    lock: () =>
      HostLockRecord.parse(JSON.parse(readFileSync(join(home, 'data', 'ui', 'host.lock'), 'utf8'))),
    stop: async () => {
      try {
        process.kill(first.hostPid);
      } catch {
        // Already gone.
      }
      // Windows releases a killed process's files only once it has exited.
      for (let i = 0; i < 50 && isAlive(first.hostPid); i++) {
        await new Promise((done) => setTimeout(done, 100));
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/** The launch code inside a `yantra ui` URL. */
export function codeOf(url: string): string {
  return url.slice(url.indexOf('#code=') + '#code='.length);
}

/** Exchanges a launch code; returns the response and, on success, the cookie and capability. */
export async function exchange(
  port: number,
  code: string,
): Promise<{ response: RawResponse; cookie: string | null; capability: string | null }> {
  const response = await rawRequest(port, {
    method: 'POST',
    path: '/session',
    headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (response.status !== 200) return { response, cookie: null, capability: null };
  const cookie =
    /yantra_session=([^;]+)/u.exec(response.headers['set-cookie']?.[0] ?? '')?.[1] ?? null;
  const capability = (JSON.parse(response.body.toString()) as { window_capability: string })
    .window_capability;
  return { response, cookie, capability };
}
