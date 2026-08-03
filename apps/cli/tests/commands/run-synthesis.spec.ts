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

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeRunCommand, resolveRunSynthesis } from '../../src/commands/run.js';

describe('@no-llm resolveRunSynthesis', () => {
  it('leaves the decision to the workflow when no flag is passed', async () => {
    const wiring = await resolveRunSynthesis({}, { ANTHROPIC_API_KEY: 'fixture' });

    expect(wiring.noLlm).toBe(false);
    expect(wiring.selection).not.toBeNull();
  });

  it('vetoes the model when --no-llm is passed', async () => {
    // Commander stores `--no-llm` as `llm: false` on the same key.
    const wiring = await resolveRunSynthesis({ llm: false }, {});

    expect(wiring.noLlm).toBe(true);
    // A null selection is what guarantees no provider adapter is constructed.
    expect(wiring.selection).toBeNull();
  });

  it('vetoes the model when --no-llm is combined with model flags', async () => {
    const wiring = await resolveRunSynthesis(
      { llm: false, model: 'claude-sonnet-5', provider: 'anthropic' },
      {},
    );

    expect(wiring.noLlm).toBe(true);
    expect(wiring.selection).toBeNull();
  });

  it('honors LLM_PROVIDER=none as a veto, exactly as ask and research do', async () => {
    const wiring = await resolveRunSynthesis({}, { LLM_PROVIDER: 'none' });

    expect(wiring.noLlm).toBe(true);
    expect(wiring.selection).toBeNull();
  });

  it('resolves the pinned default model with no model flags', async () => {
    const wiring = await resolveRunSynthesis({}, { ANTHROPIC_API_KEY: 'fixture' });

    expect(wiring.selection?.model).toMatchObject({ provider: 'anthropic' });
    expect(wiring.selection?.auth).toEqual({ mode: 'managed' });
  });

  it('honors explicit provider and model overrides', async () => {
    const wiring = await resolveRunSynthesis(
      { provider: 'ollama', model: 'llama3.1', thinking: 'low' },
      { OLLAMA_API_KEY: 'fixture' },
    );

    expect(wiring.selection?.model).toEqual({
      provider: 'ollama',
      id: 'llama3.1',
      thinking: 'low',
    });
  });

  it('reads the model from the environment', async () => {
    const wiring = await resolveRunSynthesis(
      {},
      {
        YANTRA_AGENT_PROVIDER: 'ollama',
        YANTRA_AGENT_MODEL: 'qwen3',
        OLLAMA_API_KEY: 'fixture',
      },
    );

    expect(wiring.selection?.model).toMatchObject({ provider: 'ollama', id: 'qwen3' });
  });

  it('resolves a runtime-key auth reference', async () => {
    const wiring = await resolveRunSynthesis({ authSecret: 'model.key' }, {}, new Map(), {
      probeCredential: () => Promise.resolve({ available: true, authSource: 'runtime-key' }),
    });

    expect(wiring.selection?.auth).toEqual({ mode: 'runtime-key', secretRef: 'model.key' });
  });

  it('raises a validation failure (exit 1) for a blank provider', async () => {
    await expect(resolveRunSynthesis({ provider: '  ' }, {})).rejects.toMatchObject({
      exitCode: 1,
      code: 'yantra.run.invalid-model',
    });
  });

  it('raises a validation failure for a blank --auth-secret', async () => {
    await expect(resolveRunSynthesis({ authSecret: '   ' }, {})).rejects.toMatchObject({
      exitCode: 1,
      code: 'yantra.run.invalid-auth-secret',
    });
  });

  it('does not validate model flags at all once the model is vetoed', async () => {
    // A run the user already opted out of must not be blocked by a provider it
    // will never reach.
    await expect(resolveRunSynthesis({ llm: false, provider: '  ' }, {})).resolves.toMatchObject({
      noLlm: true,
    });
    await expect(
      resolveRunSynthesis({ provider: '  ' }, { LLM_PROVIDER: 'none' }),
    ).resolves.toMatchObject({ noLlm: true });
  });
});

describe('@no-llm yantra run flag surface', () => {
  afterEach(() => vi.restoreAllMocks());
  const optionNames = (): string[] =>
    makeRunCommand()
      .options.map((option) => option.long ?? option.short ?? '')
      .filter((name) => name.length > 0);

  it('registers --no-llm', () => {
    expect(optionNames()).toContain('--no-llm');
  });

  it('rejects --template with the pointed documentation message before execution', async () => {
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit:1');
    }) as never);

    await expect(
      makeRunCommand().parseAsync(['weekly', '--template', 'exec-brief'], { from: 'user' }),
    ).rejects.toThrow('exit:1');
    expect(stderr).toBe('templates are not yet supported on run; see docs/report-templates.md\n');
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
