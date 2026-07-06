/**
 * `yantra doctor` — diagnoses the user's environment.
 *
 * v1 layers a few new check IDs on top of FEAT-003's v0 probe:
 *
 *   - `keychain.accessible` — round-trip the OS keychain with a probe key.
 *   - `providers.anthropic.api-key` — present in env or keychain.
 *   - `providers.ollama.reachable` — localhost-only HEAD probe with 1s timeout.
 *   - `search.tavily.api-key` / `search.brave.api-key` — keychain presence (warn-only).
 *   - `filesystem.disk-space` — warn under 500 MB free in the data dir.
 *
 * The probe is non-destructive; `--fix` is intentionally not implemented in
 * MVP to keep the doctor command boring and safe (memory.md §General).
 */

import { doctor as runCoreDoctor } from '@yantra/core';
import { PROTOCOL_VERSION } from '@yantra/protocol';
import { Command } from 'commander';

import { CLIConnectorIO, buildRenderOpts } from '../connector-io.js';
import { readGlobalFlags } from '../global-flags.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';
import type { DoctorRenderResult } from '../render/types.js';

interface DoctorOptions {
  readonly json?: boolean;
  readonly refresh?: boolean;
}

const CHECK_TITLES: Record<string, string> = {
  'chrome.detected': 'Chrome installation detected',
  'chrome.version_min': 'Chrome major version >= 120',
  'datadir.writable': 'Yantra data directory writable',
  'datadir.permissions': 'Yantra data directory permissions safe',
  'cachedir.writable': 'Cache directory writable',
  'keychain.reachable': 'OS keychain reachable',
  'indexdb.writable': 'Local SQLite index writable',
};

export function makeDoctorCommand(): Command {
  const cmd = new Command('doctor');

  cmd
    .description('Diagnose the local environment for Yantra')
    .option('--json', 'emit JSON output', false)
    .option('--refresh', 'bypass the diagnostic cache', false)
    .action(async (options: DoctorOptions) => {
      const flags = readGlobalFlags({
        argv: process.argv,
        env: process.env,
        isTty: process.stdout.isTTY ?? false,
      });
      const isJson = options.json === true || flags.json;
      const renderer = isJson ? new JSONRenderer() : new TerminalRenderer();
      const connector = new CLIConnectorIO(renderer);
      const renderOpts = buildRenderOpts({ ...flags, json: isJson });

      try {
        const report = await runCoreDoctor({ refresh: options.refresh === true });

        const result: DoctorRenderResult = {
          checks: report.checks.map((check) => ({
            id: check.id,
            title: CHECK_TITLES[check.id] ?? check.id,
            status: check.status === 'error' ? 'fail' : check.status,
            summary: check.message,
            ...(check.fixHint !== null ? { remediation: check.fixHint } : {}),
          })),
          overall: report.overall === 'error' ? 'fail' : report.overall,
          version: PROTOCOL_VERSION,
          platform: process.platform,
          nodeVersion: process.versions.node,
        };

        connector.renderResult({ kind: 'doctor', result }, renderOpts);
        process.exit(result.overall === 'fail' ? 3 : 0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(3);
      }
    });

  return cmd;
}
