// @no-llm
/**
 * `yantra run` synthesis flags (FEAT-FP-001, TASK-006).
 *
 * The property these tests exist to protect: **the workflow decides whether a
 * model writes its Brief, and the command line can only veto that**. `run`
 * therefore carries no opt-in mode flag — matching `ask`, `research`, and `do`,
 * none of which make the user name a mode to get their normal output — and
 * `--no-llm` is the one escape hatch, spelled the same way it is on `ask`.
 *
 * Resolving a model selection here costs nothing at runtime: it reads flags and
 * environment, and the adapter is built lazily, only for a workflow that
 * declared `synthesis.use_llm`. That laziness lives in the core stage and is
 * covered by `packages/core/tests/workflow/replay/synthesize.spec.ts`.
 */

import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import { makeRunCommand, resolveRunSynthesis } from '../../src/commands/run.js';

describe('@no-llm resolveRunSynthesis', () => {
  it('leaves the decision to the workflow when no flag is passed', () => {
    const wiring = resolveRunSynthesis({}, {});

    expect(wiring.noLlm).toBe(false);
    expect(wiring.selection).not.toBeNull();
  });

  it('vetoes the model when --no-llm is passed', () => {
    // Commander stores `--no-llm` as `llm: false` on the same key.
    const wiring = resolveRunSynthesis({ llm: false }, {});

    expect(wiring.noLlm).toBe(true);
    // A null selection is what guarantees no provider adapter is constructed.
    expect(wiring.selection).toBeNull();
  });

  it('vetoes the model when --no-llm is combined with model flags', () => {
    const wiring = resolveRunSynthesis(
      { llm: false, model: 'claude-sonnet-5', provider: 'anthropic' },
      {},
    );

    expect(wiring.noLlm).toBe(true);
    expect(wiring.selection).toBeNull();
  });

  it('honors LLM_PROVIDER=none as a veto, exactly as ask and research do', () => {
    const wiring = resolveRunSynthesis({}, { LLM_PROVIDER: 'none' });

    expect(wiring.noLlm).toBe(true);
    expect(wiring.selection).toBeNull();
  });

  it('resolves the pinned default model with no model flags', () => {
    const wiring = resolveRunSynthesis({}, {});

    expect(wiring.selection?.model).toMatchObject({ provider: 'anthropic' });
    expect(wiring.selection?.auth).toEqual({ mode: 'managed' });
  });

  it('honors explicit provider and model overrides', () => {
    const wiring = resolveRunSynthesis(
      { provider: 'ollama', model: 'llama3.1', thinking: 'low' },
      {},
    );

    expect(wiring.selection?.model).toEqual({
      provider: 'ollama',
      id: 'llama3.1',
      thinking: 'low',
    });
  });

  it('reads the model from the environment', () => {
    const wiring = resolveRunSynthesis(
      {},
      { YANTRA_AGENT_PROVIDER: 'ollama', YANTRA_AGENT_MODEL: 'qwen3' },
    );

    expect(wiring.selection?.model).toMatchObject({ provider: 'ollama', id: 'qwen3' });
  });

  it('resolves a runtime-key auth reference', () => {
    const wiring = resolveRunSynthesis({ authSecret: 'model.key' }, {});

    expect(wiring.selection?.auth).toEqual({ mode: 'runtime-key', secretRef: 'model.key' });
  });

  it('raises a validation failure (exit 1) for a blank provider', () => {
    expect(() => resolveRunSynthesis({ provider: '  ' }, {})).toThrow(CommanderError);

    try {
      resolveRunSynthesis({ provider: '  ' }, {});
      expect.unreachable('expected a validation failure');
    } catch (error) {
      expect((error as CommanderError).exitCode).toBe(1);
      expect((error as CommanderError).code).toBe('yantra.run.invalid-model');
    }
  });

  it('raises a validation failure for a blank --auth-secret', () => {
    try {
      resolveRunSynthesis({ authSecret: '   ' }, {});
      expect.unreachable('expected a validation failure');
    } catch (error) {
      expect((error as CommanderError).exitCode).toBe(1);
      expect((error as CommanderError).code).toBe('yantra.run.invalid-auth-secret');
    }
  });

  it('does not validate model flags at all once the model is vetoed', () => {
    // A run the user already opted out of must not be blocked by a provider it
    // will never reach.
    expect(() => resolveRunSynthesis({ llm: false, provider: '  ' }, {})).not.toThrow();
    expect(() => resolveRunSynthesis({ provider: '  ' }, { LLM_PROVIDER: 'none' })).not.toThrow();
  });
});

describe('@no-llm yantra run flag surface', () => {
  const optionNames = (): string[] =>
    makeRunCommand()
      .options.map((option) => option.long ?? option.short ?? '')
      .filter((name) => name.length > 0);

  it('registers --no-llm', () => {
    expect(optionNames()).toContain('--no-llm');
  });

  it('registers no --llm opt-in flag', () => {
    // The whole point of the workflow-declared mode: a user never types a mode
    // flag to get the output their workflow was saved to produce.
    expect(optionNames()).not.toContain('--llm');
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
});
