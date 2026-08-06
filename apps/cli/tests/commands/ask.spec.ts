import { Writable } from 'node:stream';

import type { AgenticTaskRequest } from '@yantra/agent';
import {
  UserInputMarkerError,
  type AskPipeline,
  type AskQuery,
  type AskRunResult,
} from '@yantra/core';
import { canonicalBrief } from '@yantra/test-helpers';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { resolveAgentInvocation } from '../../src/agent-options.js';
import { registerAskCommand, type AskRuntime } from '../../src/commands/ask.js';

const resolveAvailable: AskRuntime['resolveAgent'] = (command, options, env, prefs) =>
  resolveAgentInvocation(command, options, env, prefs, {
    probeCredential: () => Promise.resolve({ available: true, authSource: 'environment' }),
  });

function captureStream() {
  let data = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += String(chunk);
      callback();
    },
  });
  return { stream, value: () => data };
}

const okResult: AskRunResult = { brief: canonicalBrief, artifacts: null };

/** Registers ask with a mock pipeline and returns captured streams + query. */
function harness(overrides: Partial<AskRuntime> = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  let query: AskQuery | undefined;
  let agentRequest: AgenticTaskRequest | undefined;

  const program = new Command();
  program.exitOverride();
  registerAskCommand(program, {
    env: {},
    stdout: stdout.stream,
    stderr: stderr.stream,
    createPipeline: (q) => {
      query = q;
      return Promise.resolve({ run: () => Promise.resolve(okResult) } as unknown as AskPipeline);
    },
    // Hermetic defaults: no index/profile access from unit tests.
    resolveDefaults: () => Promise.resolve(new Map()),
    recordHistory: () => Promise.resolve(),
    runTask: (request) => {
      agentRequest = request;
      return Promise.resolve({
        kind: 'failed',
        runId: 'run',
        runDir: 'run',
        error: { code: 'AGENT_AUTH_UNAVAILABLE', message: 'fixture' },
      });
    },
    resolveAgent: resolveAvailable,
    ...overrides,
  });

  return { program, stdout, stderr, query: () => query, agentRequest: () => agentRequest };
}

describe('@no-llm cli/ask command', () => {
  it('treats LLM_PROVIDER=none as noLlm=true', async () => {
    const h = harness({ env: { LLM_PROVIDER: 'none' } });
    await h.program.parseAsync(['ask', 'today ai news'], { from: 'user' });
    expect(h.query()?.noLlm).toBe(true);
  });

  it('honors the --no-llm flag', async () => {
    const h = harness();
    await h.program.parseAsync(['ask', 'today ai news', '--no-llm'], { from: 'user' });
    expect(h.query()?.noLlm).toBe(true);
  });

  it('selects the shared agentic runtime when deterministic mode is not selected', async () => {
    const h = harness();
    await expect(
      h.program.parseAsync(['ask', 'today ai news'], { from: 'user' }),
    ).rejects.toMatchObject({
      exitCode: 2,
    });
    expect(h.query()).toBeUndefined();
    expect(h.agentRequest()?.profile?.command).toBe('ask');
  });

  it('uses the finite default agentic wall clock when no override is passed', async () => {
    const h = harness();
    await expect(
      h.program.parseAsync(['ask', 'today ai news'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(h.agentRequest()?.budgets?.wallClockMs).toBe(900_000);
  });

  it('passes an explicit --max-duration through as the agentic wall clock', async () => {
    const h = harness();
    // 900000 exceeds the deterministic pipeline's 300000 ceiling; the agentic
    // path must not clamp it (local models legitimately need longer runs).
    await expect(
      h.program.parseAsync(
        ['ask', 'today ai news', '--max-duration', '20m', '--pipeline-timeout', '5s'],
        { from: 'user' },
      ),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(h.agentRequest()?.budgets?.wallClockMs).toBe(1_200_000);
  });

  it('keeps --max-sources and --pipeline-timeout on the deterministic path', async () => {
    const h = harness();
    await h.program.parseAsync(
      ['ask', 'q', '--max-sources', '9', '--pipeline-timeout', '5s', '--no-llm'],
      { from: 'user' },
    );

    expect(h.query()?.budgetCalls).toBe(9);
    expect(h.query()?.pipelineBudgetMs).toBe(5_000);
  });

  it.each(['--budget', '--budget-ms'])('rejects the retired %s spelling', async (flag) => {
    const h = harness();
    await expect(
      h.program.parseAsync(['ask', 'q', flag, '5', '--no-llm'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.unknownOption' });
  });

  it('warns and returns a deterministic Brief when no credential is available', async () => {
    const h = harness({
      resolveAgent: (command, options, env, prefs) =>
        resolveAgentInvocation(command, options, env, prefs, {
          probeCredential: () => Promise.resolve({ available: false, authSource: 'unavailable' }),
        }),
    });

    await h.program.parseAsync(['ask', 'today ai news'], { from: 'user' });

    expect(h.query()?.noLlm).toBe(true);
    expect(h.stdout.value()).toContain('Cheapest Sony WH-1000XM5 today');
    expect(h.stderr.value()).toMatch(/^warning: model anthropic\/claude-haiku-4-5/u);
  });

  it('passes --length through to the synthesis budget', async () => {
    const h = harness();
    await h.program.parseAsync(['ask', 'q', '--length', 'long', '--no-llm'], { from: 'user' });
    expect(h.query()?.length).toBe('long');
  });

  it('sets noCache from --no-cache', async () => {
    const h = harness();
    await h.program.parseAsync(['ask', 'q', '--no-cache', '--no-llm'], { from: 'user' });
    expect(h.query()?.noCache).toBe(true);
  });

  it('emits the JSON Brief envelope with --json', async () => {
    const h = harness();
    await h.program.parseAsync(['ask', 'q', '--json', '--no-llm'], { from: 'user' });
    expect(h.stdout.value()).toContain('"kind":"brief"');
    expect(h.stdout.value()).toContain('Cheapest Sony WH-1000XM5 today');
    // No ANSI escapes in the machine surface.
    expect(h.stdout.value().includes(String.fromCharCode(0x1b))).toBe(false);
  });

  it('renders a styled terminal Brief by default', async () => {
    const h = harness();
    await h.program.parseAsync(['ask', 'q', '--no-llm'], { from: 'user' });
    expect(h.stdout.value()).toContain('Cheapest Sony WH-1000XM5 today');
    expect(h.stdout.value()).toContain('Sources');
  });

  it('streams Markdown with --format md', async () => {
    const h = harness();
    await h.program.parseAsync(['ask', 'q', '--format', 'md', '--no-llm'], { from: 'user' });
    expect(h.stdout.value()).toContain('# Cheapest Sony WH-1000XM5 today');
    expect(h.stdout.value()).toContain('## Sources');
  });

  it('accepts a named --search-provider and threads it into the query', async () => {
    const h = harness();
    await h.program.parseAsync(['ask', 'q', '--search-provider', 'duckduckgo', '--no-llm'], {
      from: 'user',
    });
    expect(h.query()?.searchProvider).toBe('duckduckgo');
  });

  it('rejects the retired "browser" search-provider choice', async () => {
    const h = harness();
    await expect(
      h.program.parseAsync(['ask', 'q', '--search-provider', 'browser'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.invalidArgument' });
  });

  it('leaves searchProvider null for auto (falls through to env/config)', async () => {
    const h = harness();
    await h.program.parseAsync(['ask', 'q', '--search-provider', 'auto', '--no-llm'], {
      from: 'user',
    });
    expect(h.query()?.searchProvider).toBeNull();
  });

  it('exits with code 2 when the pipeline fails', async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const program = new Command();
    program.exitOverride();
    registerAskCommand(program, {
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      createPipeline: () =>
        Promise.resolve({
          run: () => Promise.reject(new Error('boom')),
        } as unknown as AskPipeline),
    });

    await expect(
      program.parseAsync(['ask', 'q', '--no-llm'], { from: 'user' }),
    ).rejects.toMatchObject({
      exitCode: 2,
    });
    expect(stderr.value()).toContain('ask failed: boom');
  });

  it('keeps marker syntax failures as validation errors', async () => {
    const h = harness({
      runTask: () => Promise.reject(new UserInputMarkerError(4, 'unterminated')),
    });

    await expect(
      h.program.parseAsync(['ask', 'use @{broken'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(h.stderr.value()).toContain('column 5');
  });
});
