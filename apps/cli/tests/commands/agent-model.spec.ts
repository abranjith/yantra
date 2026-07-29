/**
 * The `--provider` / `--model` / `--thinking` / `--auth-secret` override
 * surface must be identical across every command that can open a provider
 * session. `ask` and `research` previously accepted neither flag and read the
 * environment only, so a user who pointed `do` at a local model could not point
 * `ask` at the same one.
 */

import { Writable } from 'node:stream';

import type { AgenticTaskOutcome, AgenticTaskRequest } from '@yantra/agent';
import type { AskPipeline, ResearchLoop, ResearchRunResult } from '@yantra/core';
import { canonicalBrief } from '@yantra/test-helpers';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_PROVIDER,
  addAgentModelOptions,
  selectAgentAuth,
  selectAgentModel,
  selectAgentSession,
} from '../../src/agent-model.js';
import { registerAskCommand } from '../../src/commands/ask.js';
import { registerDoCommand } from '../../src/commands/do.js';
import { registerResearchCommand } from '../../src/commands/research.js';

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

const failed: AgenticTaskOutcome = {
  kind: 'failed',
  runId: 'run',
  runDir: 'run',
  error: { code: 'AGENT_AUTH_UNAVAILABLE', message: 'fixture' },
};

/** Registers all three agentic commands against one captured `runTask`. */
function harness(env: NodeJS.ProcessEnv = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  let request: AgenticTaskRequest | undefined;

  const runTask = (received: AgenticTaskRequest): Promise<AgenticTaskOutcome> => {
    request = received;
    return Promise.resolve(failed);
  };
  const program = new Command().exitOverride();
  const shared = { env, stdout: stdout.stream, stderr: stderr.stream, isTty: false };

  registerDoCommand(program, { ...shared, runTask });
  registerAskCommand(program, {
    ...shared,
    runTask,
    resolveDefaults: () => Promise.resolve(new Map()),
    recordHistory: () => Promise.resolve(),
    createPipeline: () =>
      Promise.resolve({ run: () => Promise.reject(new Error('unused')) } as unknown as AskPipeline),
  });
  registerResearchCommand(program, {
    ...shared,
    runTask,
    // Hermetic: the deterministic path must never build the real loop (keychain,
    // search provider, browser) from a unit test.
    createLoop: () =>
      Promise.resolve({
        run: (): Promise<ResearchRunResult> =>
          Promise.resolve({
            brief: canonicalBrief,
            artifacts: null,
            hops: [],
            terminationReason: 'max_hops',
          }),
      } as unknown as ResearchLoop),
  });

  return {
    /** Runs argv and returns the exit code (0 when the command resolved). */
    run: async (argv: readonly string[]): Promise<number> => {
      try {
        await program.parseAsync([...argv], { from: 'user' });
        return 0;
      } catch (error) {
        return (error as { exitCode?: number }).exitCode ?? 2;
      }
    },
    request: () => request,
    stderr,
  };
}

/** The agentic commands, each with an argument that reaches the agent path. */
const AGENTIC_COMMANDS = [
  ['ask', 'what changed today'],
  ['research', 'climate policy'],
  ['do', 'submit the form'],
] as const;

describe('@no-llm shared agent model selection', () => {
  describe.each(AGENTIC_COMMANDS)('yantra %s', (name, argument) => {
    it('threads --provider and --model into the agent request', async () => {
      const h = harness();
      await h.run([name, argument, '--provider', 'ollama', '--model', 'llama3.1:8b']);

      expect(h.request()?.model).toMatchObject({ provider: 'ollama', id: 'llama3.1:8b' });
    });

    it('threads --thinking into the model selection', async () => {
      const h = harness();
      await h.run([name, argument, '--thinking', 'medium']);

      expect(h.request()?.model.thinking).toBe('medium');
    });

    it('omits thinking when the flag is absent', async () => {
      const h = harness();
      await h.run([name, argument]);

      expect(h.request()?.model.thinking).toBeUndefined();
    });

    it('selects runtime-key auth from --auth-secret', async () => {
      const h = harness();
      await h.run([name, argument, '--auth-secret', 'model.api_key']);

      expect(h.request()?.auth).toEqual({ mode: 'runtime-key', secretRef: 'model.api_key' });
    });

    it('defaults to managed auth without --auth-secret', async () => {
      const h = harness();
      await h.run([name, argument]);

      expect(h.request()?.auth).toEqual({ mode: 'managed' });
    });

    it('falls back to the YANTRA_AGENT_* environment when no flag is passed', async () => {
      const h = harness({ YANTRA_AGENT_PROVIDER: 'ollama', YANTRA_AGENT_MODEL: 'qwen3:8b' });
      await h.run([name, argument]);

      expect(h.request()?.model).toMatchObject({ provider: 'ollama', id: 'qwen3:8b' });
    });

    it('lets an explicit flag win over the environment', async () => {
      const h = harness({ YANTRA_AGENT_PROVIDER: 'ollama', YANTRA_AGENT_MODEL: 'qwen3:8b' });
      await h.run([name, argument, '--provider', 'anthropic', '--model', 'claude-haiku-4-5']);

      expect(h.request()?.model).toMatchObject({
        provider: 'anthropic',
        id: 'claude-haiku-4-5',
      });
    });

    it('falls back to the pinned defaults with neither flag nor environment', async () => {
      const h = harness();
      await h.run([name, argument]);

      expect(h.request()?.model).toMatchObject({
        provider: DEFAULT_AGENT_PROVIDER,
        id: DEFAULT_AGENT_MODEL,
      });
    });

    it('rejects a blank --provider as a validation failure (exit 1)', async () => {
      const h = harness();

      expect(await h.run([name, argument, '--provider', '  '])).toBe(1);
      expect(h.request()).toBeUndefined();
    });

    it('rejects a blank --model as a validation failure (exit 1)', async () => {
      const h = harness();

      expect(await h.run([name, argument, '--model', ''])).toBe(1);
      expect(h.request()).toBeUndefined();
    });

    it('rejects a blank --auth-secret instead of quietly using managed auth', async () => {
      const h = harness();

      expect(await h.run([name, argument, '--auth-secret', '  '])).toBe(1);
      expect(h.request()).toBeUndefined();
    });

    it('trims surrounding whitespace off provider and model values', async () => {
      const h = harness();
      await h.run([name, argument, '--provider', ' ollama ', '--model', ' llama3.1:8b ']);

      expect(h.request()?.model).toMatchObject({ provider: 'ollama', id: 'llama3.1:8b' });
    });
  });

  it('exposes the same flag set on every agentic command', () => {
    const program = new Command().exitOverride();
    const shared = {
      env: {},
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      isTty: false,
    };
    registerDoCommand(program, shared);
    registerAskCommand(program, shared);
    registerResearchCommand(program, shared);

    const surface = Object.fromEntries(
      program.commands.map((command) => [
        command.name(),
        ['--provider', '--model', '--thinking', '--auth-secret'].filter((flag) =>
          command.options.some((option) => option.long === flag),
        ),
      ]),
    );

    const expected = ['--provider', '--model', '--thinking', '--auth-secret'];
    expect(surface).toEqual({ do: expected, ask: expected, research: expected });
  });

  it('keeps --provider (LLM) and --search-provider (web backend) independent', async () => {
    const h = harness();
    await h.run(['ask', 'q', '--provider', 'ollama', '--search-provider', 'tavily']);

    // The LLM provider must not be overwritten by the search backend choice.
    expect(h.request()?.model.provider).toBe('ollama');
    // And the status line names them distinctly.
    expect(h.stderr.value()).toContain('search-provider=tavily');
    expect(h.stderr.value()).toContain('model=ollama/');
  });

  it('never constructs a model selection on the deterministic --no-llm path', async () => {
    const h = harness();
    await h.run(['ask', 'q', '--no-llm']);

    expect(h.request()).toBeUndefined();
    expect(h.stderr.value()).not.toContain('model=');
  });

  it('accepts an unusable --provider on --no-llm runs without validating it', async () => {
    // Deterministic mode never opens a provider session, so model flags are
    // inert there rather than a hard failure.
    const h = harness();

    expect(await h.run(['research', 'topic', '--provider', '', '--no-llm'])).toBe(0);
    expect(h.request()).toBeUndefined();
  });
});

describe('@no-llm agent model selection helpers', () => {
  it('applies flag > environment > default precedence', () => {
    expect(selectAgentModel('do', { provider: 'a', model: 'b' }, {})).toMatchObject({
      provider: 'a',
      id: 'b',
    });
    expect(
      selectAgentModel('do', {}, { YANTRA_AGENT_PROVIDER: 'c', YANTRA_AGENT_MODEL: 'd' }),
    ).toMatchObject({ provider: 'c', id: 'd' });
    expect(selectAgentModel('do', {}, {})).toMatchObject({
      provider: DEFAULT_AGENT_PROVIDER,
      id: DEFAULT_AGENT_MODEL,
    });
  });

  it('names the failing command in the typed validation error', () => {
    expect(() => selectAgentModel('research', { provider: '' }, {})).toThrowError(
      expect.objectContaining({ code: 'yantra.research.invalid-model', exitCode: 1 }),
    );
    expect(() => selectAgentAuth('ask', { authSecret: '' })).toThrowError(
      expect.objectContaining({ code: 'yantra.ask.invalid-auth-secret', exitCode: 1 }),
    );
  });

  it('treats a blank --thinking as unset rather than an empty level', () => {
    expect(selectAgentModel('do', { thinking: '   ' }, {}).thinking).toBeUndefined();
  });

  it('resolves model and auth together', () => {
    expect(selectAgentSession('do', { authSecret: 'k' }, {})).toEqual({
      model: { provider: DEFAULT_AGENT_PROVIDER, id: DEFAULT_AGENT_MODEL },
      auth: { mode: 'runtime-key', secretRef: 'k' },
    });
  });

  it('registers exactly the four shared flags', () => {
    const command = addAgentModelOptions(new Command('probe'));

    expect(command.options.map((option) => option.long).sort()).toEqual([
      '--auth-secret',
      '--model',
      '--provider',
      '--thinking',
    ]);
  });
});
