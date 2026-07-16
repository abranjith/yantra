import { Writable } from 'node:stream';

import { run } from '@yantra/cli';
import type { AskPipeline, AskRunResult } from '@yantra/core';
import { canonicalBrief } from '@yantra/test-helpers';
import { describe, expect, it } from 'vitest';

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

describe('@no-llm ask e2e', () => {
  it('emits a JSON Brief envelope for a query in under 5 seconds', async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const result: AskRunResult = { brief: canonicalBrief, artifacts: null };

    const started = Date.now();
    const exitCode = await run(['ask', 'fixture topic', '--json', '--no-llm'], {
      askRuntime: {
        env: {},
        stdout: stdout.stream,
        stderr: stderr.stream,
        createPipeline: () =>
          Promise.resolve({ run: () => Promise.resolve(result) } as unknown as AskPipeline),
      },
    });

    const elapsed = Date.now() - started;
    const payload = JSON.parse(stdout.value()) as {
      kind: string;
      brief: { schema_version: string; sources: unknown[] };
    };

    expect(exitCode).toBe(0);
    expect(payload.kind).toBe('brief');
    expect(payload.brief.schema_version).toBe('0.2');
    expect(payload.brief.sources.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5_000);
  });

  it('renders a styled terminal Brief by default', async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const result: AskRunResult = { brief: canonicalBrief, artifacts: null };

    const exitCode = await run(['ask', 'fixture topic', '--detail', 'full', '--no-llm'], {
      askRuntime: {
        env: {},
        stdout: stdout.stream,
        stderr: stderr.stream,
        createPipeline: () =>
          Promise.resolve({ run: () => Promise.resolve(result) } as unknown as AskPipeline),
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout.value()).toContain('Cheapest Sony WH-1000XM5 today');
    expect(stdout.value()).toContain('Sources');
  });
});
