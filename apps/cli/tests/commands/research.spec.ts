import { Writable } from 'node:stream';

import type { AgenticTaskRequest } from '@yantra/agent';
import {
  UserInputMarkerError,
  type EffectivePreferences,
  type ResearchLoop,
  type ResearchOptions,
  type ResearchRunResult,
} from '@yantra/core';
import { canonicalBrief } from '@yantra/test-helpers';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { resolveAgentInvocation } from '../../src/agent-options.js';
import {
  registerResearchCommand,
  type ResearchInvocation,
  type ResearchRuntime,
} from '../../src/commands/research.js';
import { resolveResearchBrowse } from '../../src/research-browse.js';

const resolveAvailable: ResearchRuntime['resolveAgent'] = (command, options, env, prefs) =>
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

const okResult: ResearchRunResult = {
  brief: canonicalBrief,
  artifacts: null,
  hops: [],
  terminationReason: 'max_hops',
};

/** Registers research with a mock loop and returns captured streams + options. */
function harness(overrides: Partial<ResearchRuntime> = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  let invocation: ResearchInvocation | undefined;
  let agentRequest: AgenticTaskRequest | undefined;

  const program = new Command();
  program.exitOverride();
  registerResearchCommand(program, {
    env: {},
    stdout: stdout.stream,
    stderr: stderr.stream,
    createLoop: (inv) => {
      invocation = inv;
      return Promise.resolve({ run: () => Promise.resolve(okResult) } as unknown as ResearchLoop);
    },
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

  return {
    program,
    stdout,
    stderr,
    options: (): ResearchOptions | undefined => invocation?.options,
    invocation: () => invocation,
    agentRequest: () => agentRequest,
  };
}

describe('@no-llm cli/research command', () => {
  it('defaults depth to 2 hops', async () => {
    const h = harness();
    await h.program.parseAsync(['research', 'climate policy', '--no-llm'], { from: 'user' });
    expect(h.options()?.budget.maxHops).toBe(2);
  });

  it('threads --depth into the hop budget', async () => {
    const h = harness();
    await h.program.parseAsync(['research', 'topic', '--depth', '3', '--no-llm'], { from: 'user' });
    expect(h.options()?.budget.maxHops).toBe(3);
  });

  it('rejects an out-of-range --depth with exit code 1', async () => {
    const h = harness();
    await expect(
      h.program.parseAsync(['research', 'topic', '--depth', '4'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.invalidArgument', exitCode: 1 });
  });

  it('threads --max-sources and --pipeline-timeout into the deterministic budget', async () => {
    const h = harness();
    await h.program.parseAsync(
      [
        'research',
        'topic',
        '--max-sources',
        '10',
        '--max-llm-calls',
        '8',
        '--pipeline-timeout',
        '5s',
        '--no-llm',
      ],
      { from: 'user' },
    );
    expect(h.options()?.budget.maxSources).toBe(10);
    expect(h.options()?.budget.maxWallClockMs).toBe(5_000);
    expect(h.options()?.budget.maxLlmCalls).toBe(8);
  });

  it.each(['--budget', '--budget-ms'])('rejects the retired %s spelling', async (flag) => {
    const h = harness();
    await expect(
      h.program.parseAsync(['research', 'topic', flag, '5', '--no-llm'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.unknownOption' });
  });

  it('uses the finite default agentic wall clock when no override is passed', async () => {
    const h = harness();
    await expect(
      h.program.parseAsync(['research', 'topic'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(h.agentRequest()?.budgets?.wallClockMs).toBe(900_000);
  });

  it('bounds the agentic wall clock with --max-duration', async () => {
    const h = harness();
    await expect(
      h.program.parseAsync(['research', 'topic', '--max-duration', '5m'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(h.agentRequest()?.budgets?.wallClockMs).toBe(300_000);
  });

  it('warns and returns a deterministic Brief when no credential is available', async () => {
    const h = harness({
      resolveAgent: (command, options, env, prefs) =>
        resolveAgentInvocation(command, options, env, prefs, {
          probeCredential: () => Promise.resolve({ available: false, authSource: 'unavailable' }),
        }),
    });

    await h.program.parseAsync(['research', 'topic'], { from: 'user' });

    expect(h.options()?.noLlm).toBe(true);
    expect(h.stdout.value()).toContain('Cheapest Sony WH-1000XM5 today');
    expect(h.stderr.value()).toMatch(/^warning: model anthropic\/claude-haiku-4-5/u);
  });

  it('treats LLM_PROVIDER=none as noLlm=true', async () => {
    const h = harness({ env: { LLM_PROVIDER: 'none' } });
    await h.program.parseAsync(['research', 'topic', '--no-llm'], { from: 'user' });
    expect(h.options()?.noLlm).toBe(true);
  });

  it('honors the --no-llm flag', async () => {
    const h = harness();
    await h.program.parseAsync(['research', 'topic', '--no-llm'], { from: 'user' });
    expect(h.options()?.noLlm).toBe(true);
  });

  it('defaults the final length to long', async () => {
    const h = harness();
    await h.program.parseAsync(['research', 'topic', '--no-llm'], { from: 'user' });
    expect(h.options()?.length).toBe('long');
  });

  it('emits the JSON Brief envelope with --json and no ANSI escapes', async () => {
    const h = harness();
    await h.program.parseAsync(['research', 'topic', '--json', '--no-llm'], { from: 'user' });
    expect(h.stdout.value()).toContain('"kind":"brief"');
    expect(h.stdout.value().includes(String.fromCharCode(0x1b))).toBe(false);
  });

  it('accepts a named --search-provider', async () => {
    const h = harness();
    await h.program.parseAsync(['research', 'topic', '--search-provider', 'tavily', '--no-llm'], {
      from: 'user',
    });
    expect(h.invocation()?.searchProvider).toBe('tavily');
  });

  it('selects the shared agentic runtime outside deterministic mode', async () => {
    const h = harness();
    await expect(
      h.program.parseAsync(['research', 'topic'], { from: 'user' }),
    ).rejects.toMatchObject({
      exitCode: 2,
    });
    expect(h.invocation()).toBeUndefined();
    expect(h.agentRequest()?.profile?.command).toBe('research');
  });

  it('exits with code 2 when the loop fails', async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const program = new Command();
    program.exitOverride();
    registerResearchCommand(program, {
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      createLoop: () =>
        Promise.resolve({
          run: () => Promise.reject(new Error('boom')),
        } as unknown as ResearchLoop),
    });

    await expect(
      program.parseAsync(['research', 'topic', '--no-llm'], { from: 'user' }),
    ).rejects.toMatchObject({
      exitCode: 2,
    });
    expect(stderr.value()).toContain('research failed: boom');
  });

  it('keeps marker syntax failures as validation errors', async () => {
    const h = harness({
      runTask: () => Promise.reject(new UserInputMarkerError(6, 'unknown_tag')),
    });

    await expect(
      h.program.parseAsync(['research', 'use @passwrd{x}'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(h.stderr.value()).toContain('column 7');
  });
});

describe('@no-llm cli/research goal echo (FEAT-048)', () => {
  it.each([
    ['deterministic', ['--no-llm']],
    ['agentic', []],
  ] as const)('echoes the received goal right after the preamble (%s)', async (_mode, flags) => {
    const h = harness();

    await h.program
      .parseAsync(['research', 'top 5 hybrid SUVs to buy now for under ,000', ...flags], {
        from: 'user',
      })
      .catch(() => undefined);

    const lines = h.stderr.value().split('\n');
    const preamble = lines.findIndex((line) => line.startsWith('research: search-provider='));
    expect(preamble).toBeGreaterThanOrEqual(0);
    expect(lines[preamble + 1]).toBe('goal: "top 5 hybrid SUVs to buy now for under ,000"');
  });

  it('keeps --json stdout free of the echo', async () => {
    const h = harness();

    await h.program.parseAsync(
      ['research', 'top 5 hybrid SUVs to buy now for under ,000', '--no-llm', '--json'],
      { from: 'user' },
    );

    expect(h.stderr.value()).toContain('goal: "top 5 hybrid SUVs to buy now for under ,000"\n');
    expect(h.stdout.value()).not.toContain('goal: "');
    expect(() => JSON.parse(h.stdout.value()) as unknown).not.toThrow();
  });
});

/** An effective-preference view holding exactly the given user values. */
function prefsOf(values: Readonly<Record<string, unknown>>): EffectivePreferences {
  return new Map(
    Object.entries(values).map(([key, value]) => [
      key,
      { key, value, source: 'user', approved: true, provenance: 'profile.yaml' } as const,
    ]),
  );
}

const BROWSE_TOOLS = ['browser_navigate', 'browser_observe', 'browser_extract'];

describe('@no-llm cli/research read-only browsing (FEAT-052)', () => {
  const browseHarness = (prefs: EffectivePreferences) =>
    harness({ resolveDefaults: () => Promise.resolve(prefs) });

  it('gives an agentic run the read-only browser when no preference is stored', async () => {
    const h = browseHarness(prefsOf({}));
    await h.program.parseAsync(['research', 'topic'], { from: 'user' }).catch(() => undefined);

    const tools = h.agentRequest()?.profile?.toolNames ?? [];
    for (const tool of BROWSE_TOOLS) expect(tools).toContain(tool);
    expect(tools).not.toContain('browser_click');
    expect(h.stderr.value()).toMatch(/model=\S+ browse=on\n/u);
  });

  it('honors agent.research_browse=false from the stored preference', async () => {
    const h = browseHarness(prefsOf({ 'agent.research_browse': false }));
    await h.program.parseAsync(['research', 'topic'], { from: 'user' }).catch(() => undefined);

    const tools = h.agentRequest()?.profile?.toolNames ?? [];
    for (const tool of BROWSE_TOOLS) expect(tools).not.toContain(tool);
    expect(h.stderr.value()).toMatch(/ browse=off\n/u);
  });

  it('lets --no-browse override a stored true for one run', async () => {
    const h = browseHarness(prefsOf({ 'agent.research_browse': true }));
    await h.program
      .parseAsync(['research', 'topic', '--no-browse'], { from: 'user' })
      .catch(() => undefined);

    const tools = h.agentRequest()?.profile?.toolNames ?? [];
    for (const tool of BROWSE_TOOLS) expect(tools).not.toContain(tool);
    expect(h.stderr.value()).toMatch(/ browse=off\n/u);
    expect(h.stderr.value()).not.toContain('--no-browse has no effect');
  });

  it('treats a non-boolean stored value as unset', async () => {
    const h = browseHarness(prefsOf({ 'agent.research_browse': 'no' }));
    await h.program.parseAsync(['research', 'topic'], { from: 'user' }).catch(() => undefined);

    expect(h.agentRequest()?.profile?.toolNames).toContain('browser_navigate');
  });

  it('warns once and still runs deterministically for --no-llm --no-browse', async () => {
    const h = browseHarness(prefsOf({}));
    await h.program.parseAsync(['research', 'topic', '--no-llm', '--no-browse'], {
      from: 'user',
    });

    const warnings = h.stderr
      .value()
      .split('\n')
      .filter((line) => line.includes('--no-browse'));
    expect(warnings).toEqual([
      'warning: --no-browse has no effect on deterministic research, which never opens a browsing session',
    ]);
    expect(h.options()?.noLlm).toBe(true);
    expect(h.agentRequest()).toBeUndefined();
    // The deterministic preamble never reports a browse mode.
    expect(h.stderr.value()).not.toContain('browse=');
  });

  it('warns without failing when --no-browse meets missing credentials', async () => {
    const h = harness({
      resolveDefaults: () => Promise.resolve(prefsOf({})),
      resolveAgent: (command, options, env, prefs) =>
        resolveAgentInvocation(command, options, env, prefs, {
          probeCredential: () => Promise.resolve({ available: false, authSource: 'unavailable' }),
        }),
    });
    await h.program.parseAsync(['research', 'topic', '--no-browse'], { from: 'user' });

    expect(h.options()?.noLlm).toBe(true);
    expect(h.stderr.value()).toContain('--no-browse has no effect on deterministic research');
  });

  it('keeps --json stdout unchanged by the flag', async () => {
    const plain = browseHarness(prefsOf({}));
    await plain.program.parseAsync(['research', 'topic', '--json', '--no-llm'], { from: 'user' });
    const flagged = browseHarness(prefsOf({}));
    await flagged.program.parseAsync(['research', 'topic', '--json', '--no-llm', '--no-browse'], {
      from: 'user',
    });

    expect(flagged.stdout.value()).toBe(plain.stdout.value());
    expect(flagged.stdout.value()).not.toContain('--no-browse');
  });
});

describe('@no-llm resolveResearchBrowse precedence', () => {
  it('orders flag > preference > default', () => {
    expect(
      resolveResearchBrowse({ browse: false }, prefsOf({ 'agent.research_browse': true })),
    ).toEqual({ enabled: false, source: 'flag' });
    // Commander's implicit `true` for an absent lone negation is not a choice.
    expect(
      resolveResearchBrowse({ browse: true }, prefsOf({ 'agent.research_browse': false })),
    ).toEqual({ enabled: false, source: 'preference' });
    expect(resolveResearchBrowse({}, prefsOf({ 'agent.research_browse': true }))).toEqual({
      enabled: true,
      source: 'preference',
    });
    expect(resolveResearchBrowse({}, prefsOf({}))).toEqual({ enabled: true, source: 'default' });
    expect(resolveResearchBrowse({}, prefsOf({ 'agent.research_browse': 1 }))).toEqual({
      enabled: true,
      source: 'default',
    });
  });
});
