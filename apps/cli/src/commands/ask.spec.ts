import { Writable } from 'node:stream';

import type { AskPipeline, AskQuery, AskRunResult } from '@yantra/core';
import { canonicalBrief } from '@yantra/test-helpers';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { registerAskCommand, type AskRuntime } from './ask.js';

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
    ...overrides,
  });

  return { program, stdout, stderr, query: () => query };
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

  it('defaults to the LLM synthesizer selection (noLlm=false)', async () => {
    const h = harness();
    await h.program.parseAsync(['ask', 'today ai news'], { from: 'user' });
    expect(h.query()?.noLlm).toBe(false);
  });

  it('passes --length through to the synthesis budget', async () => {
    const h = harness();
    await h.program.parseAsync(['ask', 'q', '--length', 'long'], { from: 'user' });
    expect(h.query()?.length).toBe('long');
  });

  it('sets noCache from --no-cache', async () => {
    const h = harness();
    await h.program.parseAsync(['ask', 'q', '--no-cache'], { from: 'user' });
    expect(h.query()?.noCache).toBe(true);
  });

  it('emits the JSON Brief envelope with --json', async () => {
    const h = harness();
    await h.program.parseAsync(['ask', 'q', '--json'], { from: 'user' });
    expect(h.stdout.value()).toContain('"kind":"brief"');
    expect(h.stdout.value()).toContain('Cheapest Sony WH-1000XM5 today');
    // No ANSI escapes in the machine surface.
    expect(h.stdout.value().includes(String.fromCharCode(0x1b))).toBe(false);
  });

  it('renders a styled terminal Brief by default', async () => {
    const h = harness();
    await h.program.parseAsync(['ask', 'q'], { from: 'user' });
    expect(h.stdout.value()).toContain('Cheapest Sony WH-1000XM5 today');
    expect(h.stdout.value()).toContain('Sources');
  });

  it('streams Markdown with --format md', async () => {
    const h = harness();
    await h.program.parseAsync(['ask', 'q', '--format', 'md'], { from: 'user' });
    expect(h.stdout.value()).toContain('# Cheapest Sony WH-1000XM5 today');
    expect(h.stdout.value()).toContain('## Sources');
  });

  it('accepts a named --search-provider and threads it into the query', async () => {
    const h = harness();
    await h.program.parseAsync(['ask', 'q', '--search-provider', 'duckduckgo'], { from: 'user' });
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
    await h.program.parseAsync(['ask', 'q', '--search-provider', 'auto'], { from: 'user' });
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

    await expect(program.parseAsync(['ask', 'q'], { from: 'user' })).rejects.toMatchObject({
      exitCode: 2,
    });
    expect(stderr.value()).toContain('ask failed: boom');
  });
});
