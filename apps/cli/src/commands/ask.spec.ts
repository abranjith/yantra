import { Writable } from 'node:stream';

import type { AskCard, AskPipeline } from '@yantra/core';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { registerAskCommand } from './ask.js';

function captureStream() {
  let data = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += String(chunk);
      callback();
    },
  });

  return {
    stream,
    value: () => data,
  };
}

const sampleCards: AskCard[] = [
  {
    url: 'https://example.com',
    title: 'Example',
    source: 'example.com',
    fetchedAt: '2026-05-11T10:14:00.000Z',
    publishedAt: null,
    summary: 'summary',
    summaryKind: 'rule-based',
    quotedSnippet: 'snippet',
    tags: ['ai'],
    notice: null,
  },
];

describe('@no-llm cli/ask command', () => {
  it('honors LLM_PROVIDER=none as noLlm=true', async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    let seenNoLlm = false;

    const program = new Command();
    registerAskCommand(program, {
      env: { LLM_PROVIDER: 'none' },
      stdout: stdout.stream,
      stderr: stderr.stream,
      createPipeline: (query) => {
        seenNoLlm = query.noLlm;
        return Promise.resolve({
          run: () => Promise.resolve(sampleCards),
        } as unknown as AskPipeline);
      },
    });

    await program.parseAsync(['ask', 'today ai news'], { from: 'user' });

    expect(seenNoLlm).toBe(true);
  });

  it('honors --no-llm flag', async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    let seenNoLlm = false;

    const program = new Command();
    registerAskCommand(program, {
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      createPipeline: (query) => {
        seenNoLlm = query.noLlm;
        return Promise.resolve({
          run: () => Promise.resolve(sampleCards),
        } as unknown as AskPipeline);
      },
    });

    await program.parseAsync(['ask', 'today ai news', '--no-llm'], { from: 'user' });

    expect(seenNoLlm).toBe(true);
  });

  it('prints JSON when --json is provided', async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const program = new Command();
    registerAskCommand(program, {
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      createPipeline: () =>
        Promise.resolve({
          run: () => Promise.resolve(sampleCards),
        } as unknown as AskPipeline),
    });

    await program.parseAsync(['ask', 'today ai news', '--json'], { from: 'user' });

    expect(stdout.value()).toContain('"cards"');
    expect(stdout.value()).toContain('"summaryKind": "rule-based"');
  });
});
