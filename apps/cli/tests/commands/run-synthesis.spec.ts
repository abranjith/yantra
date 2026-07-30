// @no-llm
/**
 * `yantra run` synthesis flags (FEAT-FP-001, TASK-006).
 *
 * The property these tests exist to protect: a replay opens a provider session
 * **only** when the user asked for one with `--llm`. Everything else — a stray
 * `--model`, a `YANTRA_AGENT_*` environment, a workflow that declares
 * `synthesis:` — still runs deterministically and touches no model.
 */

import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import { makeRunCommand, resolveRunSynthesis } from '../../src/commands/run.js';

describe('@no-llm resolveRunSynthesis', () => {
  it('forces the deterministic path when --llm is absent', () => {
    const wiring = resolveRunSynthesis({}, {});

    expect(wiring.noLlm).toBe(true);
    // A null selection is what guarantees no provider adapter is constructed.
    expect(wiring.selection).toBeNull();
  });

  it('constructs no selection when --model is passed without --llm', () => {
    const wiring = resolveRunSynthesis({ model: 'claude-sonnet-5' }, {});

    expect(wiring.noLlm).toBe(true);
    expect(wiring.selection).toBeNull();
  });

  it('constructs no selection when --no-llm is combined with model flags', () => {
    // Commander stores `--no-llm` as `llm: false` on the same key.
    const wiring = resolveRunSynthesis(
      { llm: false, model: 'claude-sonnet-5', provider: 'anthropic' },
      {},
    );

    expect(wiring.noLlm).toBe(true);
    expect(wiring.selection).toBeNull();
  });

  it('ignores a YANTRA_AGENT_* environment without --llm', () => {
    const wiring = resolveRunSynthesis(
      {},
      { YANTRA_AGENT_PROVIDER: 'anthropic', YANTRA_AGENT_MODEL: 'claude-sonnet-5' },
    );

    expect(wiring.selection).toBeNull();
  });

  it('resolves the pinned default model when --llm is passed bare', () => {
    const wiring = resolveRunSynthesis({ llm: true }, {});

    expect(wiring.noLlm).toBe(false);
    expect(wiring.selection?.model).toMatchObject({ provider: 'anthropic' });
    expect(wiring.selection?.auth).toEqual({ mode: 'managed' });
  });

  it('honors explicit provider and model overrides under --llm', () => {
    const wiring = resolveRunSynthesis(
      { llm: true, provider: 'ollama', model: 'llama3.1', thinking: 'low' },
      {},
    );

    expect(wiring.selection?.model).toEqual({
      provider: 'ollama',
      id: 'llama3.1',
      thinking: 'low',
    });
  });

  it('reads the model from the environment under --llm', () => {
    const wiring = resolveRunSynthesis(
      { llm: true },
      { YANTRA_AGENT_PROVIDER: 'ollama', YANTRA_AGENT_MODEL: 'qwen3' },
    );

    expect(wiring.selection?.model).toMatchObject({ provider: 'ollama', id: 'qwen3' });
  });

  it('resolves a runtime-key auth reference under --llm', () => {
    const wiring = resolveRunSynthesis({ llm: true, authSecret: 'model.key' }, {});

    expect(wiring.selection?.auth).toEqual({ mode: 'runtime-key', secretRef: 'model.key' });
  });

  it('raises a validation failure (exit 1) for a blank provider under --llm', () => {
    expect(() => resolveRunSynthesis({ llm: true, provider: '  ' }, {})).toThrow(CommanderError);

    try {
      resolveRunSynthesis({ llm: true, provider: '  ' }, {});
    } catch (error) {
      expect((error as CommanderError).exitCode).toBe(1);
      expect((error as CommanderError).code).toBe('yantra.run.invalid-model');
    }
  });

  it('raises a validation failure for a blank --auth-secret under --llm', () => {
    try {
      resolveRunSynthesis({ llm: true, authSecret: '   ' }, {});
      expect.unreachable('expected a validation failure');
    } catch (error) {
      expect((error as CommanderError).exitCode).toBe(1);
      expect((error as CommanderError).code).toBe('yantra.run.invalid-auth-secret');
    }
  });

  it('does not validate model flags at all without --llm', () => {
    // A deterministic replay must not be blocked by a provider it never uses.
    expect(() => resolveRunSynthesis({ provider: '  ' }, {})).not.toThrow();
  });
});

describe('@no-llm yantra run flag surface', () => {
  const optionNames = (): string[] =>
    makeRunCommand()
      .options.map((option) => option.long ?? option.short ?? '')
      .filter((name) => name.length > 0);

  it('registers --llm and --no-llm', () => {
    const names = optionNames();

    expect(names).toContain('--llm');
    expect(names).toContain('--no-llm');
  });

  it('registers the same model surface as ask/research/do', () => {
    const names = optionNames();

    for (const flag of ['--provider', '--model', '--thinking', '--auth-secret']) {
      expect(names).toContain(flag);
    }
  });

  it('keeps the existing replay flags', () => {
    const names = optionNames();

    for (const flag of ['--params', '--params-file', '--json', '--debug']) {
      expect(names).toContain(flag);
    }
  });

  it('defaults --llm to off', () => {
    const llm = makeRunCommand().options.find((option) => option.long === '--llm');

    expect(llm?.defaultValue).toBe(false);
  });
});
