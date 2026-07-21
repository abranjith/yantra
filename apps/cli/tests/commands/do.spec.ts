import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';

import type { AgenticTaskOutcome, AgenticTaskRequest } from '@yantra/agent';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

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
  options: { readonly isTty?: boolean; readonly render?: boolean } = {},
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
    if (options.render) request.connector.renderAgentOutcome(terminal);
    return Promise.resolve(terminal);
  });
  const program = new Command().exitOverride();
  registerDoCommand(program, {
    runTask,
    env: {},
    stdout: stdout.stream,
    stderr: stderr.stream,
    isTty: options.isTty ?? false,
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
        '--max-tool-calls',
        '12',
        '--max-cost-usd',
        '1.5',
        '--confirmation-timeout-ms',
        '5000',
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
      budgets: { totalToolCalls: 12, maxProviderCostUsd: 1.5, confirmationWaitMs: 5000 },
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

  it('honors the YANTRA_AGENT_DO_* budget env overrides via the resolved profile', async () => {
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
      env: { YANTRA_AGENT_DO_MAX_TOOL_CALLS: '7' },
      stdout: stdout.stream,
      stderr: stderr.stream,
      isTty: false,
    });
    await program.parseAsync(['do', 'goal'], { from: 'user' });

    expect(captured?.profile?.budgets.totalToolCalls).toBe(7);
  });

  it('surfaces AGENT_AUTH_UNAVAILABLE actionably without a null fallback', async () => {
    const result = await invoke(['do', 'goal'], outcome('failed'), { render: true });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('AGENT_AUTH_UNAVAILABLE: Configure auth.');
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
    expect((await invoke(['do', 'goal', '--budget-ms', '0'], outcome('published'))).exitCode).toBe(
      1,
    );
    expect(
      (await invoke(['do', 'goal', '--allow-host', 'bad host'], outcome('published'))).exitCode,
    ).toBe(1);
  });

  it('keeps the CLI free of manual discovery-loop imports and duplicate history', async () => {
    const source = await readFile(new URL('../../src/commands/do.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/runDiscoverySession|discovery\.jsonl|propose\(|buildObservation/);
    expect(source).toContain('runAgenticTask');
  });
});
