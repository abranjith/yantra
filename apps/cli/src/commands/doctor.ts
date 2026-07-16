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
 *
 * `--agent-smoke [provider/model]` (FEAT-022) runs a LIVE agent provider
 * smoke instead of the offline checks: it opens a real Pi session against
 * the pinned Yantra environment, invokes the registered `status` tool once,
 * streams the normalized events, persists the session under
 * `runs/<run-id>/agent/`, and closes cleanly. Missing credentials exit with
 * the typed `AGENT_AUTH_UNAVAILABLE` error (exit 3) — never a null client.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AgentStartupError, runAgentSmoke, type AgentEvent } from '@yantra/agent';
import { configPath, doctor as runCoreDoctor, runsRoot } from '@yantra/core';
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
  readonly agentSmoke?: boolean | string;
}

/** Default smoke target when `--agent-smoke` is passed without a value. */
const DEFAULT_SMOKE_MODEL = 'anthropic/claude-haiku-4-5';

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
    .option(
      '--agent-smoke [provider/model]',
      `run a live agent provider smoke test (default: ${DEFAULT_SMOKE_MODEL})`,
    )
    .action(async (options: DoctorOptions) => {
      if (options.agentSmoke !== undefined && options.agentSmoke !== false) {
        await runAgentSmokeCommand(options.agentSmoke);
        return;
      }
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

/**
 * Live agent provider smoke (FEAT-022). Prints normalized events as they
 * stream, then a summary. Exit codes: 0 = session opened, `status` tool
 * round-tripped, clean close; 3 = typed startup/environment failure;
 * 130 = aborted via Ctrl+C (clean teardown).
 */
async function runAgentSmokeCommand(target: boolean | string): Promise<void> {
  const spec = typeof target === 'string' && target.length > 0 ? target : DEFAULT_SMOKE_MODEL;
  const slash = spec.indexOf('/');
  if (slash <= 0 || slash === spec.length - 1) {
    process.stderr.write(`Invalid --agent-smoke value "${spec}" (expected provider/model-id)\n`);
    process.exit(1);
  }
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);

  const runId = `agent-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = join(runsRoot(), runId);
  await mkdir(runDir, { recursive: true, mode: 0o700 });

  const piAuthPath = await readPiAuthPathOptIn();

  const controller = new AbortController();
  const onSigint = (): void => {
    process.stdout.write('\nAborting agent smoke (Ctrl+C)...\n');
    controller.abort();
  };
  process.once('SIGINT', onSigint);

  process.stdout.write(`Agent smoke: ${provider}/${modelId}\n`);
  process.stdout.write(`Run directory: ${runDir}\n\n`);

  try {
    const report = await runAgentSmoke({
      model: { provider, id: modelId },
      runId,
      runDir,
      ...(piAuthPath !== undefined ? { personalPiAuthPath: piAuthPath } : {}),
      signal: controller.signal,
      onEvent: renderSmokeEvent,
    });

    process.stdout.write('\n--- environment (pinned, zero ambient resources) ---\n');
    process.stdout.write(`  agentDir:   ${report.enumeration.agentDir}\n`);
    process.stdout.write(`  auth:       ${report.enumeration.authPath}\n`);
    process.stdout.write(`  models:     ${report.enumeration.modelsPath}\n`);
    process.stdout.write(`  settings:   ${report.enumeration.settingsSource}\n`);
    process.stdout.write(
      `  resources:  extensions=${report.enumeration.extensions.length} ` +
        `skills=${report.enumeration.skills.length} prompts=${report.enumeration.prompts.length} ` +
        `themes=${report.enumeration.themes.length} contextFiles=${report.enumeration.contextFiles.length}\n`,
    );

    process.stdout.write('\n--- result ---\n');
    process.stdout.write(`  session:    ${report.sessionId}\n`);
    process.stdout.write(`  log:        ${report.logPath}\n`);
    process.stdout.write(`  outcome:    ${report.result.outcome} (${report.result.stopReason})\n`);
    const usage = report.result.usage;
    process.stdout.write(
      `  usage:      turns=${usage.turns}` +
        (usage.inputTokens !== undefined ? ` in=${usage.inputTokens}` : '') +
        (usage.outputTokens !== undefined ? ` out=${usage.outputTokens}` : '') +
        (usage.costUsd !== undefined ? ` cost=$${usage.costUsd.toFixed(4)}` : '') +
        '\n',
    );
    process.stdout.write(
      `  status tool: ${report.statusToolInvoked ? 'invoked ✓' : 'NOT invoked'}\n`,
    );

    if (report.result.outcome === 'aborted') {
      process.exit(130);
    }
    if (report.result.outcome !== 'completed' || !report.statusToolInvoked) {
      process.stderr.write('\nAgent smoke FAILED: see events above.\n');
      process.exit(3);
    }
    process.stdout.write('\nAgent smoke PASSED.\n');
    process.exit(0);
  } catch (err) {
    if (err instanceof AgentStartupError) {
      process.stderr.write(`\n${err.code}: ${err.message}\n`);
    } else {
      process.stderr.write(
        `\nAgent smoke error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    process.exit(3);
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

/** Compact one-line rendering of a normalized agent event. */
function renderSmokeEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'tool_started':
      process.stdout.write(`[tool_started]  ${event.tool} (${event.callId})\n`);
      break;
    case 'tool_finished':
      process.stdout.write(
        `[tool_finished] ${event.tool} (${event.callId}) error=${String(event.isError)}\n`,
      );
      break;
    case 'assistant_text':
      process.stdout.write(event.text);
      break;
    case 'turn_finished':
      process.stdout.write(`\n[turn_finished] turns=${event.usage.turns}\n`);
      break;
    case 'failed':
      process.stdout.write(`[failed] ${event.error.code}: ${event.error.message}\n`);
      break;
  }
}

/**
 * Read the documented `agent.pi_auth_path` opt-in from config.yaml
 * (docs/model-configuration.md). Missing/unreadable config yields undefined —
 * the pinned auth store stays the default.
 */
async function readPiAuthPathOptIn(): Promise<string | undefined> {
  try {
    const { parse } = await import('yaml');
    const contents = await readFile(configPath(), 'utf8');
    const raw = parse(contents) as { agent?: { pi_auth_path?: unknown } } | null;
    const path = raw?.agent?.pi_auth_path;
    return typeof path === 'string' && path.length > 0 ? path : undefined;
  } catch {
    return undefined;
  }
}
