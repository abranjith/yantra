import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type { AgentSmokeOptions } from '@yantra/agent';
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
