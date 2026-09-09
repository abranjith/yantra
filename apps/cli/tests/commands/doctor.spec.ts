import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { runAgentDiagnostics, type AgentSmokeOptions } from '@yantra/agent';
import { CommanderError } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';

import { makeDoctorCommand, type DoctorRuntime } from '../../src/commands/doctor.js';

function capture(): { readonly stream: Writable; readonly read: () => string } {
  let output = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, done) {
        output += String(chunk);
        done();
      },
    }),
    read: () => output,
  };
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('doctor agent checks', () => {
  it('includes all agent check ids in JSON and rolls missing credentials up to warn', async () => {
    const stdout = capture();
    const stderr = capture();
    const coreDoctor: DoctorRuntime['coreDoctor'] = () =>
      Promise.resolve({
        generatedAt: '2026-08-02T00:00:00.000Z',
        cachedFrom: null,
        overall: 'ok',
        checks: [
          {
            id: 'datadir.writable',
            status: 'ok',
            message: 'Writable.',
            details: {},
            fixHint: null,
          },
        ],
      });
    const agentDiagnostics: DoctorRuntime['agentDiagnostics'] = () =>
      Promise.resolve([
        {
          id: 'agent.model',
          status: 'ok',
          message: 'Agent model: anthropic/claude-haiku-4-5.',
          details: {},
          fixHint: null,
        },
        {
          id: 'agent.credentials',
          status: 'warn',
          message: 'No credential is available.',
          details: { authSource: 'unavailable' },
          fixHint: 'Set a provider credential.',
        },
        {
          id: 'agent.budgets',
          status: 'ok',
          message: 'Agent budgets resolved.',
          details: {},
          fixHint: null,
        },
      ]);

    const command = makeDoctorCommand({
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      isTty: false,
      coreDoctor,
      agentDiagnostics,
      loadPreferences: () => Promise.resolve(new Map()),
    });
    await command.parseAsync(['--json'], { from: 'user' });

    const report = JSON.parse(stdout.read()) as {
      readonly overall: string;
      readonly checks: readonly { readonly id: string }[];
    };
    expect(report.checks.map((check) => check.id)).toEqual([
      'datadir.writable',
      'agent.model',
      'agent.credentials',
      'agent.budgets',
      'config.valid',
      'paths.resolved',
      'ethics.robots',
      'search.tavily.api-key',
      'search.brave.api-key',
    ]);
    expect(report.overall).toBe('warn');
    expect(stderr.read()).toBe('');
  });

  it('targets smoke with the shared provider and model flags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-doctor-'));
    temporaryDirectories.push(root);
    const stdout = capture();
    const stderr = capture();
    let captured: AgentSmokeOptions | undefined;
    const smoke: DoctorRuntime['smoke'] = (options) => {
      captured = options;
      return Promise.resolve({
        sessionId: 'smoke-session',
        logPath: join(root, 'session.jsonl'),
        result: { outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } },
        events: [],
        statusToolInvoked: true,
        enumeration: {
          agentDir: join(root, 'pi'),
          authPath: join(root, 'pi', 'auth.json'),
          modelsPath: join(root, 'pi', 'models.json'),
          sessionStagingDir: join(root, 'pi', 'sessions'),
          settingsSource: 'in-memory',
          systemPrompt: 'smoke',
          appendSystemPrompt: [],
          extensions: [],
          skills: [],
          prompts: [],
          themes: [],
          contextFiles: [],
        },
      });
    };

    const command = makeDoctorCommand({
      env: { OLLAMA_API_KEY: 'present-for-offline-probe' },
      stdout: stdout.stream,
      stderr: stderr.stream,
      isTty: false,
      loadPreferences: () => Promise.resolve(new Map()),
      smoke,
      runsRoot: () => root,
    });
    await command.parseAsync(['--agent-smoke', '--provider', 'ollama', '--model', 'llama3.1:8b'], {
      from: 'user',
    });

    expect(captured?.model).toEqual({ provider: 'ollama', id: 'llama3.1:8b' });
    expect(stdout.read()).toContain('Agent smoke: ollama/llama3.1:8b');
    expect(stderr.read()).toBe('');
  });

  it('no longer accepts a provider/model value after --agent-smoke', async () => {
    const command = makeDoctorCommand();
    command.exitOverride();

    await expect(
      command.parseAsync(['--agent-smoke', 'ollama/llama3.1:8b'], { from: 'user' }),
    ).rejects.toBeInstanceOf(CommanderError);
  });
});

/** A passing smoke report, parameterized where a test needs a different outcome. */
function smokeReport(
  root: string,
  overrides: {
    readonly outcome?: 'completed' | 'failed' | 'aborted';
    readonly statusToolInvoked?: boolean;
  } = {},
): ReturnType<DoctorRuntime['smoke']> {
  return Promise.resolve({
    sessionId: 'smoke-session',
    logPath: join(root, 'session.jsonl'),
    result: {
      outcome: overrides.outcome ?? 'completed',
      stopReason: 'stop',
      usage: { turns: 1, inputTokens: 42, outputTokens: 7 },
    },
    events: [],
    statusToolInvoked: overrides.statusToolInvoked ?? true,
    enumeration: {
      agentDir: join(root, 'pi'),
      authPath: join(root, 'pi', 'auth.json'),
      modelsPath: join(root, 'pi', 'models.json'),
      sessionStagingDir: join(root, 'pi', 'sessions'),
      settingsSource: 'in-memory',
      systemPrompt: 'smoke',
      appendSystemPrompt: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
      contextFiles: [],
    },
  });
}

describe('doctor option surface', () => {
  const registered = (): readonly string[] =>
    makeDoctorCommand()
      .options.map((option) => option.long)
      .filter((long): long is string => long !== undefined);

  it('registers the model-selection vocabulary spelled exactly as its siblings do', () => {
    expect(registered()).toEqual([
      '--provider',
      '--model',
      '--thinking',
      '--auth-secret',
      '--no-llm',
      '--json',
      '--refresh',
      '--agent-smoke',
    ]);
  });

  it.each([
    '--max-duration',
    '--max-tokens',
    '--tool-timeout',
    '--tool-retries',
    '--confirm-timeout',
    '--no-screenshots',
  ])('does not register %s, which doctor cannot honor', (flag) => {
    expect(registered()).not.toContain(flag);
  });

  it.each([
    ['--max-duration', '20m'],
    ['--max-tokens', '400'],
    ['--tool-timeout', '4m'],
    ['--tool-retries', '5'],
    ['--confirm-timeout', '6m'],
  ])('rejects %s rather than accepting it and discarding it', async (flag, value) => {
    const command = makeDoctorCommand();
    command.exitOverride();
    command.configureOutput({ writeErr: () => undefined });

    await expect(command.parseAsync([flag, value], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.unknownOption',
    });
  });

  it('rejects --no-screenshots, which doctor never captures for', async () => {
    const command = makeDoctorCommand();
    command.exitOverride();
    command.configureOutput({ writeErr: () => undefined });

    await expect(command.parseAsync(['--no-screenshots'], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.unknownOption',
    });
  });

  it('describes --refresh as covering only the cached environment probe', () => {
    const refresh = makeDoctorCommand().options.find((option) => option.long === '--refresh');

    expect(refresh?.description).toContain('cached probe');
    expect(refresh?.description).toContain('always run fresh');
  });
});

describe('doctor deterministic path', () => {
  it.each([
    [['--no-llm'], {}, '--no-llm'],
    [[], { LLM_PROVIDER: 'none' }, 'LLM_PROVIDER=none'],
  ])('reports the no-LLM selection made by %j in the agent checks', async (argv, env, spelling) => {
    const stdout = capture();
    const stderr = capture();
    const command = makeDoctorCommand({
      env,
      stdout: stdout.stream,
      stderr: stderr.stream,
      isTty: false,
      coreDoctor: () =>
        Promise.resolve({
          generatedAt: '2026-08-02T00:00:00.000Z',
          cachedFrom: null,
          overall: 'ok',
          checks: [],
        }),
      // The real diagnostics: the point of the test is that the deterministic
      // selection reaches them at all.
      agentDiagnostics: runAgentDiagnostics,
      loadPreferences: () => Promise.resolve(new Map()),
    });
    await command.parseAsync([...argv, '--json'], { from: 'user' });

    const report = JSON.parse(stdout.read()) as {
      readonly checks: readonly {
        readonly id: string;
        readonly status: string;
        readonly summary: string;
      }[];
    };
    const agentChecks = report.checks.filter((check) => check.id.startsWith('agent.'));
    expect(agentChecks).toHaveLength(3);
    for (const check of agentChecks) {
      expect(check.status).toBe('ok');
      expect(check.summary).toContain(spelling);
    }
  });

  it('fails the budget check when a stored budget no agentic command could parse is set', async () => {
    const stdout = capture();
    const command = makeDoctorCommand({
      env: { YANTRA_AGENT_MAX_DURATION: 'soon' },
      stdout: stdout.stream,
      stderr: capture().stream,
      isTty: false,
      coreDoctor: () =>
        Promise.resolve({
          generatedAt: '2026-08-02T00:00:00.000Z',
          cachedFrom: null,
          overall: 'ok',
          checks: [],
        }),
      agentDiagnostics: runAgentDiagnostics,
      loadPreferences: () => Promise.resolve(new Map()),
    });
    command.exitOverride();

    await expect(command.parseAsync(['--json'], { from: 'user' })).rejects.toMatchObject({
      code: 'yantra.doctor.failed',
      exitCode: 3,
    });

    const report = JSON.parse(stdout.read()) as {
      readonly overall: string;
      readonly checks: readonly { readonly id: string; readonly status: string }[];
    };
    expect(report.checks.find((check) => check.id === 'agent.budgets')?.status).toBe('fail');
    expect(report.overall).toBe('fail');
  });
});

describe('doctor --agent-smoke output modes', () => {
  it('names the environment variable, not the flag, when the environment selected no-LLM', async () => {
    const stderr = capture();
    const command = makeDoctorCommand({
      env: { LLM_PROVIDER: 'none' },
      stdout: capture().stream,
      stderr: stderr.stream,
      isTty: false,
      loadPreferences: () => Promise.resolve(new Map()),
    });
    command.exitOverride();

    await expect(command.parseAsync(['--agent-smoke'], { from: 'user' })).rejects.toMatchObject({
      code: 'yantra.doctor.llm-required',
      exitCode: 1,
    });
    expect(stderr.read()).toContain('unset LLM_PROVIDER=none');
    expect(stderr.read()).not.toContain('remove --no-llm');
  });

  it('names the flag when the flag selected no-LLM', async () => {
    const stderr = capture();
    const command = makeDoctorCommand({
      env: {},
      stdout: capture().stream,
      stderr: stderr.stream,
      isTty: false,
      loadPreferences: () => Promise.resolve(new Map()),
    });
    command.exitOverride();

    await expect(
      command.parseAsync(['--agent-smoke', '--no-llm'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'yantra.doctor.llm-required', exitCode: 1 });
    expect(stderr.read()).toContain('remove --no-llm');
    expect(stderr.read()).not.toContain('LLM_PROVIDER');
  });

  it('emits one parseable JSON object and no streamed prose under --json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-doctor-'));
    temporaryDirectories.push(root);
    const stdout = capture();
    const stderr = capture();
    let onEventSupplied = true;
    const command = makeDoctorCommand({
      env: { OLLAMA_API_KEY: 'present-for-offline-probe' },
      stdout: stdout.stream,
      stderr: stderr.stream,
      isTty: false,
      loadPreferences: () => Promise.resolve(new Map()),
      smoke: (options) => {
        onEventSupplied = options.onEvent !== undefined;
        return smokeReport(root);
      },
      runsRoot: () => root,
    });
    await command.parseAsync(
      ['--agent-smoke', '--json', '--provider', 'ollama', '--model', 'llama3.1:8b'],
      { from: 'user' },
    );

    const emitted = JSON.parse(stdout.read()) as {
      readonly kind: string;
      readonly outcome: string;
      readonly provider: string;
      readonly model: string;
      readonly sessionId: string;
      readonly statusToolInvoked: boolean;
      readonly usage: { readonly turns: number; readonly inputTokens?: number };
      readonly environment: { readonly extensions: number };
    };
    expect(emitted.kind).toBe('doctor_smoke');
    expect(emitted.outcome).toBe('passed');
    expect(emitted.provider).toBe('ollama');
    expect(emitted.model).toBe('llama3.1:8b');
    expect(emitted.sessionId).toBe('smoke-session');
    expect(emitted.statusToolInvoked).toBe(true);
    expect(emitted.usage).toMatchObject({ turns: 1, inputTokens: 42 });
    expect(emitted.environment.extensions).toBe(0);
    // No live event stream and no human progress lines may share the stream
    // with the JSON document.
    expect(onEventSupplied).toBe(false);
    expect(stdout.read()).not.toContain('Agent smoke:');
    expect(stdout.read()).not.toContain('--- result ---');
  });

  it('still renders the human summary and streams events without --json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-doctor-'));
    temporaryDirectories.push(root);
    const stdout = capture();
    let onEventSupplied = false;
    const command = makeDoctorCommand({
      env: { OLLAMA_API_KEY: 'present-for-offline-probe' },
      stdout: stdout.stream,
      stderr: capture().stream,
      isTty: false,
      loadPreferences: () => Promise.resolve(new Map()),
      smoke: (options) => {
        onEventSupplied = options.onEvent !== undefined;
        return smokeReport(root);
      },
      runsRoot: () => root,
    });
    await command.parseAsync(['--agent-smoke', '--provider', 'ollama', '--model', 'x'], {
      from: 'user',
    });

    expect(onEventSupplied).toBe(true);
    const output = stdout.read();
    expect(output).toContain('Agent smoke: ollama/x');
    expect(output).toContain('--- result ---');
    expect(output).toContain('session:    smoke-session');
    expect(output).toContain('Agent smoke PASSED.');
  });

  it('reports a failed smoke as JSON and still exits 3', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-doctor-'));
    temporaryDirectories.push(root);
    const stdout = capture();
    const stderr = capture();
    const command = makeDoctorCommand({
      env: { OLLAMA_API_KEY: 'present-for-offline-probe' },
      stdout: stdout.stream,
      stderr: stderr.stream,
      isTty: false,
      loadPreferences: () => Promise.resolve(new Map()),
      smoke: () => smokeReport(root, { statusToolInvoked: false }),
      runsRoot: () => root,
    });
    command.exitOverride();

    await expect(
      command.parseAsync(['--agent-smoke', '--json', '--provider', 'ollama'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'yantra.doctor.agent-smoke-failed', exitCode: 3 });

    const emitted = JSON.parse(stdout.read()) as {
      readonly kind: string;
      readonly outcome: string;
      readonly statusToolInvoked: boolean;
    };
    expect(emitted.kind).toBe('doctor_smoke');
    expect(emitted.outcome).toBe('failed');
    expect(emitted.statusToolInvoked).toBe(false);
    expect(stderr.read()).toContain('Agent smoke FAILED');
  });
});
