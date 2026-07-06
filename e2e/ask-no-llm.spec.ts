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

describe('@no-llm ask e2e no-llm mode', () => {
  it('sets noLlm=true when LLM_PROVIDER=none and still emits a deterministic Brief', async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    let observedNoLlm = false;
    const result: AskRunResult = { brief: canonicalBrief, artifacts: null };

    const exitCode = await run(['ask', 'fixture topic', '--json'], {
      askRuntime: {
        env: { LLM_PROVIDER: 'none' },
        stdout: stdout.stream,
        stderr: stderr.stream,
        createPipeline: (query) => {
          observedNoLlm = query.noLlm;
          return Promise.resolve({ run: () => Promise.resolve(result) } as unknown as AskPipeline);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(observedNoLlm).toBe(true);
    expect(stdout.value()).toContain('"kind":"brief"');
    expect(stdout.value()).toContain('"synthesis":"deterministic"');
  });
});
