import { Writable } from 'node:stream';

import type { ResearchLoop, ResearchOptions, ResearchRunResult } from '@yantra/core';
import { canonicalBrief } from '@yantra/test-helpers';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
  registerResearchCommand,
  type ResearchInvocation,
  type ResearchRuntime,
} from './research.js';

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
    ...overrides,
  });

  return {
    program,
    stdout,
    stderr,
    options: (): ResearchOptions | undefined => invocation?.options,
    invocation: () => invocation,
  };
}

describe('@no-llm cli/research command', () => {
  it('defaults depth to 2 hops', async () => {
    const h = harness();
    await h.program.parseAsync(['research', 'climate policy'], { from: 'user' });
    expect(h.options()?.budget.maxHops).toBe(2);
  });

  it('threads --depth into the hop budget', async () => {
    const h = harness();
    await h.program.parseAsync(['research', 'topic', '--depth', '3'], { from: 'user' });
    expect(h.options()?.budget.maxHops).toBe(3);
  });

  it('rejects an out-of-range --depth with exit code 1', async () => {
    const h = harness();
    await expect(
      h.program.parseAsync(['research', 'topic', '--depth', '4'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.invalidArgument', exitCode: 1 });
  });

  it('threads --max-sources and --budget-ms into the budget', async () => {
    const h = harness();
    await h.program.parseAsync(
      ['research', 'topic', '--max-sources', '10', '--budget-ms', '5000'],
      { from: 'user' },
    );
    expect(h.options()?.budget.maxSources).toBe(10);
    expect(h.options()?.budget.maxWallClockMs).toBe(5_000);
  });

  it('treats LLM_PROVIDER=none as noLlm=true', async () => {
    const h = harness({ env: { LLM_PROVIDER: 'none' } });
    await h.program.parseAsync(['research', 'topic'], { from: 'user' });
    expect(h.options()?.noLlm).toBe(true);
  });

  it('honors the --no-llm flag', async () => {
    const h = harness();
    await h.program.parseAsync(['research', 'topic', '--no-llm'], { from: 'user' });
    expect(h.options()?.noLlm).toBe(true);
  });

  it('defaults the final length to long', async () => {
    const h = harness();
    await h.program.parseAsync(['research', 'topic'], { from: 'user' });
    expect(h.options()?.length).toBe('long');
  });

  it('emits the JSON Brief envelope with --json and no ANSI escapes', async () => {
    const h = harness();
    await h.program.parseAsync(['research', 'topic', '--json'], { from: 'user' });
    expect(h.stdout.value()).toContain('"kind":"brief"');
    expect(h.stdout.value().includes(String.fromCharCode(0x1b))).toBe(false);
  });

  it('accepts a named --search-provider', async () => {
    const h = harness();
    await h.program.parseAsync(['research', 'topic', '--search-provider', 'tavily'], {
      from: 'user',
    });
    expect(h.invocation()?.searchProvider).toBe('tavily');
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

    await expect(program.parseAsync(['research', 'topic'], { from: 'user' })).rejects.toMatchObject(
      {
        exitCode: 2,
      },
    );
    expect(stderr.value()).toContain('research failed: boom');
  });
});
