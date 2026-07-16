import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  DEFAULT_SCRIPT_LIMITS,
  ScriptRegistry,
  type ScriptDefinition,
} from '../../src/scripts/registry.js';

const noAbort = { signal: new AbortController().signal };

describe('@no-llm ScriptRegistry lookup and validation', () => {
  it('returns SCRIPT_NOT_FOUND for an unregistered id without executing anything', async () => {
    const registry = new ScriptRegistry();
    const outcome = await registry.run('rm -rf /', { text: 'x' }, noAbort);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe('SCRIPT_NOT_FOUND');
  });

  it('rejects arguments that fail the script schema', async () => {
    const registry = new ScriptRegistry();
    const outcome = await registry.run('table_normalize', { text: 42 }, noAbort);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe('SCRIPT_INVALID_ARGS');
      expect(outcome.retryable).toBe(true);
    }
  });

  it('rejects duplicate ids at construction time', () => {
    const dup: ScriptDefinition = {
      id: 'x',
      description: 'x',
      argsSchema: z.object({}).strict(),
      limits: DEFAULT_SCRIPT_LIMITS,
      transform: () => null,
    };
    expect(() => new ScriptRegistry([dup, dup])).toThrow(/Duplicate script id/);
  });
});

describe('@no-llm ScriptRegistry out-of-process execution', () => {
  it('runs table_normalize end-to-end through a worker', async () => {
    const registry = new ScriptRegistry();
    const outcome = await registry.run(
      'table_normalize',
      { text: 'a, b ,c\n1,2,3\n 4 ,5,6' },
      noAbort,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.output).toEqual({
        headers: ['a', 'b', 'c'],
        rows: [
          ['1', '2', '3'],
          ['4', '5', '6'],
        ],
      });
      expect(outcome.truncated).toBe(false);
    }
  });

  it('kills a runaway script at the timeout with a stable code', async () => {
    const spin: ScriptDefinition = {
      id: 'spin',
      description: 'test-only infinite loop',
      argsSchema: z.object({}).strict(),
      limits: { timeoutMs: 100, maxOutputBytes: 1024, memoryMb: 64 },
      // Self-contained infinite loop — no closure over test scope.
      transform: () => {
         
        while (true) {
          /* spin */
        }
      },
    };
    const registry = new ScriptRegistry([spin]);
    const outcome = await registry.run('spin', {}, noAbort);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe('SCRIPT_TIMEOUT');
  }, 10_000);

  it('truncates oversized output and flags it', async () => {
    const big: ScriptDefinition = {
      id: 'big',
      description: 'produces a large payload',
      argsSchema: z.object({}).strict(),
      limits: { timeoutMs: 2_000, maxOutputBytes: 64, memoryMb: 64 },
      transform: () => 'x'.repeat(5_000),
    };
    const registry = new ScriptRegistry([big]);
    const outcome = await registry.run('big', {}, noAbort);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.truncated).toBe(true);
  });

  it('aborts before execution when the signal is already aborted', async () => {
    const registry = new ScriptRegistry();
    const controller = new AbortController();
    controller.abort();
    const outcome = await registry.run('table_normalize', { text: 'a\n1' }, {
      signal: controller.signal,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe('SCRIPT_ABORTED');
  });
});

describe('@no-llm ScriptRegistry property: only registered ids ever execute', () => {
  it('returns SCRIPT_NOT_FOUND for arbitrary unregistered id strings', async () => {
    const registry = new ScriptRegistry();
    const registered = new Set(registry.ids());
    await fc.assert(
      fc.asyncProperty(fc.string(), async (id) => {
        if (registered.has(id)) return; // skip the (few) real ids
        const outcome = await registry.run(id, {}, noAbort);
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.errorCode).toBe('SCRIPT_NOT_FOUND');
      }),
      { numRuns: 50 },
    );
  });
});
