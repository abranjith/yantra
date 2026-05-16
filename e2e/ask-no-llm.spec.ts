import { Writable } from 'node:stream';

import { run } from '@yantra/cli';
import type { AskCard, AskPipeline } from '@yantra/core';
import { describe, expect, it } from 'vitest';

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

describe('@no-llm ask e2e no-llm mode', () => {
  it('sets noLlm=true when LLM_PROVIDER=none and still succeeds', async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    let observedNoLlm = false;

    const cards: AskCard[] = [
      {
        url: 'https://example.com/one',
        title: 'One',
        source: 'example.com',
        fetchedAt: '2026-05-11T10:14:00.000Z',
        publishedAt: null,
        summary: 'Summary one.',
        summaryKind: 'rule-based',
        quotedSnippet: 'Snippet one.',
        tags: ['ai'],
        notice: null,
      },
      {
        url: 'https://example.com/two',
        title: 'Two',
        source: 'example.com',
        fetchedAt: '2026-05-11T10:14:00.000Z',
        publishedAt: null,
        summary: 'Summary two.',
        summaryKind: 'rule-based',
        quotedSnippet: 'Snippet two.',
        tags: ['ai'],
        notice: null,
      },
      {
        url: 'https://example.com/three',
        title: 'Three',
        source: 'example.com',
        fetchedAt: '2026-05-11T10:14:00.000Z',
        publishedAt: null,
        summary: 'Summary three.',
        summaryKind: 'rule-based',
        quotedSnippet: 'Snippet three.',
        tags: ['ai'],
        notice: null,
      },
    ];

    const exitCode = await run(['ask', 'fixture topic', '--json'], {
      askRuntime: {
        env: { LLM_PROVIDER: 'none' },
        stdout: stdout.stream,
        stderr: stderr.stream,
        createPipeline: (query) => {
          observedNoLlm = query.noLlm;
          return Promise.resolve({
            run: () => Promise.resolve(cards),
          } as unknown as AskPipeline);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(observedNoLlm).toBe(true);
    expect(stdout.value()).toContain('"cards"');
  });
});
