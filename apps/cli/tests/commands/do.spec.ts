import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';

import type { AgenticTaskOutcome, AgenticTaskRequest } from '@yantra/agent';
import { UserInputMarkerError } from '@yantra/core';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { resolveAgentInvocation } from '../../src/agent-options.js';
import { registerDoCommand } from '../../src/commands/do.js';

function capture(): { stream: Writable; value: () => string } {
  let output = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    }),
    value: () => output,
  };
}

function outcome(kind: AgenticTaskOutcome['kind']): AgenticTaskOutcome {
  const base = { runId: 'run-1', runDir: '/runs/run-1' };
  switch (kind) {
    case 'published':
      return {
        kind,
        ...base,
        brief: {
          briefId: 'brief-1',
          jsonPath: '/runs/run-1/brief.json',
          markdownPath: '/runs/run-1/brief.md',
          htmlPath: '/runs/run-1/brief.html',
        },
      };
    case 'handoff':
      return { kind, ...base, blocker: 'CAPTCHA', safestNextAction: 'Complete it manually.' };
    case 'failed':
      return {
        kind,
        ...base,
        error: { code: 'AGENT_AUTH_UNAVAILABLE', message: 'Configure auth.' },
      };
    case 'budget_exhausted':
      return { kind, ...base, error: { code: 'AGENT_BUDGET_EXHAUSTED', message: 'Budget used.' } };
    case 'aborted':
      return { kind, ...base, error: { code: 'AGENT_ABORTED', message: 'Interrupted.' } };
  }
}

async function invoke(
  argv: readonly string[],
  terminal: AgenticTaskOutcome,
  options: {
    readonly isTty?: boolean;
    readonly render?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly runError?: unknown;
    readonly warning?: string;
  } = {},
): Promise<{
  readonly exitCode: number;
  readonly request: AgenticTaskRequest;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const stdout = capture();
  const stderr = capture();
  let captured: AgenticTaskRequest | undefined;
  const runTask = vi.fn((request: AgenticTaskRequest) => {
    captured = request;
    if (options.warning) request.connector.emitAgentWarning?.(options.warning);
    if (options.runError !== undefined) return Promise.reject(options.runError);
    if (options.render) request.connector.renderAgentOutcome(terminal);
    return Promise.resolve(terminal);
  });
  const program = new Command().exitOverride();
  registerDoCommand(program, {
    runTask,
    env: options.env ?? {},
    stdout: stdout.stream,
    stderr: stderr.stream,
    isTty: options.isTty ?? false,
    resolveAgent: (command, agentOptions, env, prefs) =>
      resolveAgentInvocation(command, agentOptions, env, prefs, {
        probeCredential: () => Promise.resolve({ available: true, authSource: 'environment' }),
      }),
  });
  let exitCode = 0;
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    exitCode = (error as { exitCode?: number }).exitCode ?? 2;
  }
  return { exitCode, request: captured!, stdout: stdout.value(), stderr: stderr.value() };
}

describe('@no-llm yantra do cutover', () => {
  it('rejects --no-llm with guidance and opens no agent session', async () => {
    const result = await invoke(['do', 'goal', '--no-llm'], outcome('published'));

    expect(result.exitCode).toBe(1);
    expect(result.request).toBeUndefined();
    expect(result.stderr).toContain(
      '`do` runs a web agent and requires a model; use `ask --no-llm` or `research --no-llm` for deterministic web research.',
    );
  });

  it('treats LLM_PROVIDER=none exactly like --no-llm', async () => {
    const result = await invoke(['do', 'goal'], outcome('published'), {
      env: { LLM_PROVIDER: 'none' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.request).toBeUndefined();
  });

  it('parses model, auth, host, and budget flags into one AgenticTaskRequest', async () => {
    const result = await invoke(
      [
        'do',
        'submit the form',
        '--provider',
        'fixture',
        '--model',
        'fixture-model',
        '--thinking',
        'medium',
        '--auth-secret',
        'model.api_key',
        '--allow-host',
        'EXAMPLE.com',
        '--max-duration',
        '20m',
        '--max-tokens',
        '12000',
        '--tool-timeout',
        '2m',
        '--tool-retries',
        '4',
        '--confirm-timeout',
        '5s',
        '--save-as',
        'future-workflow',
      ],
      outcome('published'),
    );

    expect(result.exitCode).toBe(0);
    expect(result.request).toMatchObject({
      goal: 'submit the form',
      model: { provider: 'fixture', id: 'fixture-model', thinking: 'medium' },
      auth: { mode: 'runtime-key', secretRef: 'model.api_key' },
      allowedHosts: ['example.com'],
      budgets: {
        wallClockMs: 1_200_000,
        maxProviderTokens: 12_000,
        perToolTimeoutMs: 120_000,
        toolRetries: 4,
        confirmationWaitMs: 5_000,
      },
    });
  });

  it.each([
    ['published', 0],
    ['failed', 2],
    ['budget_exhausted', 2],
    ['handoff', 4],
    ['aborted', 130],
  ] as const)('maps %s to exit %i', async (kind, expected) => {
    expect((await invoke(['do', 'goal'], outcome(kind))).exitCode).toBe(expected);
  });

  it('passes the explicit least-privilege do profile, not the runtime default', async () => {
    const result = await invoke(['do', 'goal'], outcome('published'));

    // Wiring the profile explicitly is what differentiates `do` from `ask`;
    // relying on the runtime's implicit default hid the coupling.
    expect(result.request.profile).toBeDefined();
    expect(result.request.profile?.command).toBe('do');
    expect(result.request.profile?.briefKind).toBe('task');
  });

  it('honors the shared YANTRA_AGENT_* budget environment overrides', async () => {
    const stdout = capture();
    const stderr = capture();
    let captured: AgenticTaskRequest | undefined;
    const runTask = vi.fn((request: AgenticTaskRequest) => {
      captured = request;
      return Promise.resolve(outcome('published'));
    });
    const program = new Command().exitOverride();
    registerDoCommand(program, {
      runTask,
      env: { YANTRA_AGENT_MAX_DURATION: '7m' },
      stdout: stdout.stream,
      stderr: stderr.stream,
      isTty: false,
      resolveAgent: (command, options, env, prefs) =>
        resolveAgentInvocation(command, options, env, prefs, {
          probeCredential: () => Promise.resolve({ available: true, authSource: 'environment' }),
        }),
    });
    await program.parseAsync(['do', 'goal'], { from: 'user' });

    expect(captured?.budgets?.wallClockMs).toBe(420_000);
    expect(captured?.profile).not.toHaveProperty('budgets');
  });

  it('renders a typed runtime failure without a null fallback', async () => {
    const result = await invoke(['do', 'goal'], outcome('failed'), { render: true });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('AGENT_AUTH_UNAVAILABLE: Configure auth.');
  });

  it('exits 3 with AGENT_AUTH_UNAVAILABLE when the offline probe finds no credential', async () => {
    const stdout = capture();
    const stderr = capture();
    const runTask = vi.fn(() => Promise.resolve(outcome('published')));
    const program = new Command().exitOverride();
    registerDoCommand(program, {
      runTask,
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      isTty: false,
      resolveAgent: (command, options, env, prefs) =>
        resolveAgentInvocation(command, options, env, prefs, {
          probeCredential: () => Promise.resolve({ available: false, authSource: 'unavailable' }),
        }),
    });

    await expect(program.parseAsync(['do', 'goal'], { from: 'user' })).rejects.toMatchObject({
      code: 'AGENT_AUTH_UNAVAILABLE',
      exitCode: 3,
    });
    expect(stderr.value()).toContain('AGENT_AUTH_UNAVAILABLE');
    expect(runTask).not.toHaveBeenCalled();
  });

  it('uses a non-interactive connector and parseable NDJSON in --json mode', async () => {
    const result = await invoke(['do', 'goal', '--json'], outcome('failed'), { render: true });
    const line = JSON.parse(result.stdout.trim()) as { kind: string; outcome: { kind: string } };

    expect(result.request.connector.interactive).toBe(false);
    expect(line).toMatchObject({ kind: 'agent_outcome', outcome: { kind: 'failed' } });
  });

  it('marks the request interactive only for an attended (TTY, non-JSON) run', async () => {
    // Drives the flow-aware prompt: an attended run tells the agent a user can
    // approve protected actions; --json and non-TTY runs stay unattended.
    expect(
      (await invoke(['do', 'goal'], outcome('published'), { isTty: true })).request.interactive,
    ).toBe(true);
    expect(
      (await invoke(['do', 'goal'], outcome('published'), { isTty: false })).request.interactive,
    ).toBe(false);
    expect(
      (await invoke(['do', 'goal', '--json'], outcome('published'), { isTty: true })).request
        .interactive,
    ).toBe(false);
  });

  it('rejects malformed budget and host flags as validation errors', async () => {
    expect(
      (await invoke(['do', 'goal', '--max-duration', '0'], outcome('published'))).exitCode,
    ).toBe(1);
    expect(
      (await invoke(['do', 'goal', '--allow-host', 'bad host'], outcome('published'))).exitCode,
    ).toBe(1);
  });

  it('maps marker syntax failures to exit 1 without echoing a marked value', async () => {
    const result = await invoke(['do', 'login with @password{p1'], outcome('published'), {
      runError: new UserInputMarkerError(11, 'unterminated'),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('column 12');
    expect(result.stderr).not.toContain('p1');
  });

  it('prints user-input warnings on stderr but suppresses them under --json', async () => {
    const warning = 'use `@{...}` to guarantee masking';
    const human = await invoke(['do', 'password p1'], outcome('published'), { warning });
    const json = await invoke(['do', 'password p1', '--json'], outcome('published'), { warning });

    expect(human.exitCode).toBe(0);
    expect(human.stderr).toContain(`warning: ${warning}`);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).not.toContain(warning);
  });

  it.each([
    '--budget-ms',
    '--max-tool-calls',
    '--max-calls-per-tool',
    '--tool-timeout-ms',
    '--max-provider-tokens',
    '--max-cost-usd',
    '--confirmation-timeout-ms',
  ])('rejects the retired %s spelling', async (flag) => {
    expect((await invoke(['do', 'goal', flag, '5'], outcome('published'))).exitCode).toBe(1);
  });

  it('keeps the CLI free of manual discovery-loop imports and duplicate history', async () => {
    const source = await readFile(new URL('../../src/commands/do.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/runDiscoverySession|discovery\.jsonl|propose\(|buildObservation/);
    expect(source).toContain('runAgenticTask');
  });
});
