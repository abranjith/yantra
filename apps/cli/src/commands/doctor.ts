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
 * `--agent-smoke` (FEAT-022) runs a LIVE agent provider
 * smoke instead of the offline checks: it opens a real Pi session against
 * the pinned Yantra environment, invokes the registered `status` tool once,
 * streams the normalized events, persists the session under
 * `runs/<run-id>/agent/`, and closes cleanly. Missing credentials exit with
 * the typed `AGENT_AUTH_UNAVAILABLE` error (exit 3) — never a null client.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AgentAuthUnavailableError,
  AgentStartupError,
  runAgentDiagnostics,
  runAgentSmoke,
  type AgentEvent,
} from '@yantra/agent';
import {
  cacheDir,
  createKeychainProvider,
  dataDir,
  doctor as runCoreDoctor,
  loadConfig,
  resolveSearchCredential,
  runsRoot,
  storageDirSources,
} from '@yantra/core';
import { PROTOCOL_VERSION } from '@yantra/protocol';
import { Command, CommanderError } from 'commander';

import {
  addAgentOptions,
  resolveAgentInvocation,
  type AgentInvocation,
  type AgentOptions,
} from '../agent-options.js';
import { CLIConnectorIO, buildRenderOpts } from '../connector-io.js';
import { readGlobalFlags } from '../global-flags.js';
import { loadEffectivePreferences } from '../preferences.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';
import type { DoctorRenderResult } from '../render/types.js';

interface DoctorOptions extends AgentOptions {
  readonly json?: boolean;
  readonly refresh?: boolean;
  readonly agentSmoke?: boolean;
}

type LlmAgentInvocation = Extract<AgentInvocation, { readonly mode: 'llm' }>;

/** Injectable boundaries used by the command regression tests. */
export interface DoctorRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly isTty: boolean;
  readonly coreDoctor: typeof runCoreDoctor;
  readonly agentDiagnostics: typeof runAgentDiagnostics;
  readonly loadPreferences: typeof loadEffectivePreferences;
  readonly smoke: typeof runAgentSmoke;
  readonly runsRoot: typeof runsRoot;
}

const CHECK_TITLES: Record<string, string> = {
  'chrome.detected': 'Chrome installation detected',
  'chrome.version_min': 'Chrome major version >= 120',
  'datadir.writable': 'Yantra data directory writable',
  'datadir.permissions': 'Yantra data directory permissions safe',
  'cachedir.writable': 'Cache directory writable',
  'keychain.reachable': 'OS keychain reachable',
  'indexdb.writable': 'Local SQLite index writable',
  'agent.model': 'Agent model selection',
  'agent.credentials': 'Agent credential availability',
  'agent.budgets': 'Agent runtime budgets',
  'config.valid': 'Configuration schema valid',
  'paths.resolved': 'Storage paths resolved',
  'ethics.robots': 'Robots policy',
  'search.tavily.api-key': 'Tavily API key',
  'search.brave.api-key': 'Brave API key',
};

export function makeDoctorCommand(runtime?: Partial<DoctorRuntime>): Command {
  const resolved = doctorRuntime(runtime);
  const cmd = new Command('doctor');

  addAgentOptions(cmd.description('Diagnose the local environment for Yantra'))
    .option('--json', 'emit JSON output', false)
    .option('--refresh', 'bypass the diagnostic cache', false)
    .option('--agent-smoke', 'run a live agent provider smoke test', false)
    .action(async (options: DoctorOptions) => {
      const preferences = await resolved.loadPreferences();
      if (options.agentSmoke === true) {
        const agent = await resolveAgentInvocation('doctor', options, resolved.env, preferences);
        if (agent.mode === 'no-llm') {
          if (agent.reason === 'unavailable') {
            const error = new AgentAuthUnavailableError(
              agent.model.provider,
              'managed store, provider environment, runtime-key reference',
              'Set the provider API key, seed managed auth, or pass --auth-secret <ref>.',
            );
            resolved.stderr.write(`${error.code}: ${error.message}\n`);
            throw new CommanderError(3, error.code, error.message);
          }
          const message = '`doctor --agent-smoke` requires an LLM; remove --no-llm.';
          resolved.stderr.write(`${message}\n`);
          throw new CommanderError(1, 'yantra.doctor.llm-required', message);
        }
        await runAgentSmokeCommand(agent, resolved);
        return;
      }
      const flags = readGlobalFlags({
        argv: process.argv,
        env: resolved.env,
        isTty: resolved.isTty,
      });
      const isJson = options.json === true || flags.json;
      const renderer = isJson ? new JSONRenderer() : new TerminalRenderer();
      const connector = new CLIConnectorIO(renderer);
      const renderOpts = buildRenderOpts(
        { ...flags, json: isJson },
        { stdout: resolved.stdout, stderr: resolved.stderr },
      );

      try {
        const [report, agentChecks, configChecks] = await Promise.all([
          resolved.coreDoctor({ refresh: options.refresh === true }),
          resolved.agentDiagnostics(resolved.env, preferences, options),
          runConfigurationChecks(resolved.env),
        ]);
        const checks = [...report.checks, ...agentChecks, ...configChecks];

        const result: DoctorRenderResult = {
          checks: checks.map((check) => ({
            id: check.id,
            title: CHECK_TITLES[check.id] ?? check.id,
            status: check.status === 'error' ? 'fail' : check.status,
            summary: check.message,
            ...(check.fixHint !== null ? { remediation: check.fixHint } : {}),
          })),
          overall: checks.some((check) => check.status === 'error')
            ? 'fail'
            : checks.some((check) => check.status === 'warn')
              ? 'warn'
              : 'ok',
          version: PROTOCOL_VERSION,
          platform: process.platform,
          nodeVersion: process.versions.node,
        };

        connector.renderResult({ kind: 'doctor', result }, renderOpts);
        if (result.overall === 'fail') {
          throw new CommanderError(3, 'yantra.doctor.failed', 'Environment checks failed.');
        }
      } catch (err) {
        if (err instanceof CommanderError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        resolved.stderr.write(`Error: ${message}\n`);
        throw new CommanderError(3, 'yantra.doctor.failed', message);
      }
    });

  return cmd;
}

interface ConfigurationDoctorCheck {
  readonly id:
    | 'config.valid'
    | 'paths.resolved'
    | 'ethics.robots'
    | 'search.tavily.api-key'
    | 'search.brave.api-key';
  readonly status: 'ok' | 'warn' | 'error';
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly fixHint: string | null;
}

async function runConfigurationChecks(
  env: NodeJS.ProcessEnv,
): Promise<readonly ConfigurationDoctorCheck[]> {
  const loaded = await loadConfig();
  if (!loaded.isOk) {
    return [
      {
        id: 'config.valid',
        status: 'error',
        message: loaded.error.message,
        details: { issues: loaded.error.issues.map((issue) => issue.keyPath) },
        fixHint: 'Run `yantra config validate`, correct the named keys, and retry.',
      },
    ];
  }

  const sources = storageDirSources();
  const checks: ConfigurationDoctorCheck[] = [
    {
      id: 'config.valid',
      status: 'ok',
      message: 'Configuration is schema-valid.',
      details: {},
      fixHint: null,
    },
    {
      id: 'paths.resolved',
      status: 'ok',
      message: `Storage paths: data=${dataDir()} (${sources.dataSource}), cache=${cacheDir()} (${sources.cacheSource}).`,
      details: {
        dataDir: dataDir(),
        dataSource: sources.dataSource,
        cacheDir: cacheDir(),
        cacheSource: sources.cacheSource,
      },
      fixHint: null,
    },
    {
      id: 'ethics.robots',
      status: 'ok',
      message: `Robots policy is ${loaded.value.ethics.robots_enabled ? 'enabled' : 'disabled'}.`,
      details: { enabled: loaded.value.ethics.robots_enabled },
      fixHint: null,
    },
  ];

  let keychain;
  try {
    keychain = await createKeychainProvider();
  } catch {
    keychain = null;
  }
  for (const provider of ['tavily', 'brave'] as const) {
    let source: 'env' | 'keychain' | 'absent' = 'absent';
    if (keychain) {
      try {
        const credential = await resolveSearchCredential(provider, keychain, undefined, env);
        source = credential?.source ?? 'absent';
      } catch {
        source = 'absent';
      }
    }
    checks.push({
      id: `search.${provider}.api-key`,
      status: source === 'absent' ? 'warn' : 'ok',
      message:
        source === 'absent'
          ? `No ${provider} API key is available.`
          : `${provider} API key is present (source: ${source}).`,
      details: { source },
      fixHint:
        source === 'absent'
          ? `Run \`yantra secret set ${provider}.api_key\` or configure an \${env:NAME} reference.`
          : null,
    });
  }
  return checks;
}

/**
 * Live agent provider smoke (FEAT-022). Prints normalized events as they
 * stream, then a summary. Exit codes: 0 = session opened, `status` tool
 * round-tripped, clean close; 3 = typed startup/environment failure;
 * 130 = aborted via Ctrl+C (clean teardown).
 */
async function runAgentSmokeCommand(
  agent: LlmAgentInvocation,
  runtime: DoctorRuntime,
): Promise<void> {
  const { provider, id: modelId } = agent.model;
  const runId = `agent-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = join(runtime.runsRoot(), runId);
  await mkdir(runDir, { recursive: true, mode: 0o700 });

  const piAuthPath = await readPiAuthPathOptIn();

  const controller = new AbortController();
  const onSigint = (): void => {
    runtime.stdout.write('\nAborting agent smoke (Ctrl+C)...\n');
    controller.abort();
  };
  process.once('SIGINT', onSigint);

  runtime.stdout.write(`Agent smoke: ${provider}/${modelId}\n`);
  runtime.stdout.write(`Run directory: ${runDir}\n\n`);

  try {
    const keychain = agent.auth.mode === 'runtime-key' ? await createKeychainProvider() : null;
    const report = await runtime.smoke({
      model: agent.model,
      auth: agent.auth,
      runId,
      runDir,
      ...(piAuthPath !== undefined ? { personalPiAuthPath: piAuthPath } : {}),
      ...(keychain === null
        ? {}
        : {
            resolveSecret: async (secretRef: string) => {
              const value = await keychain.get('yantra', secretRef);
              if (value === null) throw new Error(`secret reference "${secretRef}" was not found`);
              return value;
            },
          }),
      signal: controller.signal,
      onEvent: (event) => renderSmokeEvent(event, runtime.stdout),
    });

    runtime.stdout.write('\n--- environment (pinned, zero ambient resources) ---\n');
    runtime.stdout.write(`  agentDir:   ${report.enumeration.agentDir}\n`);
    runtime.stdout.write(`  auth:       ${report.enumeration.authPath}\n`);
    runtime.stdout.write(`  models:     ${report.enumeration.modelsPath}\n`);
    runtime.stdout.write(`  settings:   ${report.enumeration.settingsSource}\n`);
    runtime.stdout.write(
      `  resources:  extensions=${report.enumeration.extensions.length} ` +
        `skills=${report.enumeration.skills.length} prompts=${report.enumeration.prompts.length} ` +
        `themes=${report.enumeration.themes.length} contextFiles=${report.enumeration.contextFiles.length}\n`,
    );

    runtime.stdout.write('\n--- result ---\n');
    runtime.stdout.write(`  session:    ${report.sessionId}\n`);
    runtime.stdout.write(`  log:        ${report.logPath}\n`);
    runtime.stdout.write(`  outcome:    ${report.result.outcome} (${report.result.stopReason})\n`);
    const usage = report.result.usage;
    runtime.stdout.write(
      `  usage:      turns=${usage.turns}` +
        (usage.inputTokens !== undefined ? ` in=${usage.inputTokens}` : '') +
        (usage.outputTokens !== undefined ? ` out=${usage.outputTokens}` : '') +
        (usage.costUsd !== undefined ? ` cost=$${usage.costUsd.toFixed(4)}` : '') +
        '\n',
    );
    runtime.stdout.write(
      `  status tool: ${report.statusToolInvoked ? 'invoked ✓' : 'NOT invoked'}\n`,
    );

    if (report.result.outcome === 'aborted') {
      throw new CommanderError(130, 'yantra.doctor.agent-smoke-aborted', 'Agent smoke aborted.');
    }
    if (report.result.outcome !== 'completed' || !report.statusToolInvoked) {
      runtime.stderr.write('\nAgent smoke FAILED: see events above.\n');
      throw new CommanderError(3, 'yantra.doctor.agent-smoke-failed', 'Agent smoke failed.');
    }
    runtime.stdout.write('\nAgent smoke PASSED.\n');
  } catch (err) {
    if (err instanceof CommanderError) throw err;
    if (err instanceof AgentStartupError) {
      runtime.stderr.write(`\n${err.code}: ${err.message}\n`);
    } else {
      runtime.stderr.write(
        `\nAgent smoke error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    throw new CommanderError(
      3,
      err instanceof AgentStartupError ? err.code : 'yantra.doctor.agent-smoke-failed',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

/** Compact one-line rendering of a normalized agent event. */
function renderSmokeEvent(event: AgentEvent, stream: NodeJS.WritableStream): void {
  switch (event.type) {
    case 'tool_started':
      stream.write(`[tool_started]  ${event.tool} (${event.callId})\n`);
      break;
    case 'tool_finished':
      stream.write(
        `[tool_finished] ${event.tool} (${event.callId}) error=${String(event.isError)}\n`,
      );
      break;
    case 'assistant_text':
      stream.write(event.text);
      break;
    case 'turn_finished':
      stream.write(`\n[turn_finished] turns=${event.usage.turns}\n`);
      break;
    case 'failed':
      stream.write(`[failed] ${event.error.code}: ${event.error.message}\n`);
      break;
  }
}

function doctorRuntime(runtime?: Partial<DoctorRuntime>): DoctorRuntime {
  return {
    env: runtime?.env ?? process.env,
    stdout: runtime?.stdout ?? process.stdout,
    stderr: runtime?.stderr ?? process.stderr,
    isTty: runtime?.isTty ?? process.stdout.isTTY ?? false,
    coreDoctor: runtime?.coreDoctor ?? runCoreDoctor,
    agentDiagnostics: runtime?.agentDiagnostics ?? runAgentDiagnostics,
    loadPreferences: runtime?.loadPreferences ?? loadEffectivePreferences,
    smoke: runtime?.smoke ?? runAgentSmoke,
    runsRoot: runtime?.runsRoot ?? runsRoot,
  };
}

/**
 * Read the documented `agent.pi_auth_path` opt-in from config.yaml
 * (docs/usage.md). Missing/unreadable config yields undefined —
 * the pinned auth store stays the default.
 */
async function readPiAuthPathOptIn(): Promise<string | undefined> {
  const loaded = await loadConfig();
  return loaded.isOk ? (loaded.value.agent.pi_auth_path ?? undefined) : undefined;
}
