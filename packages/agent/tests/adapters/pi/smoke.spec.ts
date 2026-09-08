/**
 * @no-llm Agent smoke runner tests (FEAT-022 TASK-006).
 *
 * Startup failures use the real environment (temp-dir backed); the full
 * round-trip uses a stubbed Pi session via the `createSession` seam — the
 * live provider path is exercised by `yantra doctor --agent-smoke`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { defaultConfig, type YantraConfig } from '@yantra/core';
import { afterEach, describe, expect, it } from 'vitest';

import type { PiSessionLike } from '../../../src/adapters/pi/provider.js';
import { runAgentSmoke } from '../../../src/adapters/pi/smoke.js';
import { AgentAuthUnavailableError, AgentModelNotFoundError } from '../../../src/errors.js';
import type { AgentEvent } from '../../../src/provider/index.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

/**
 * The hermetic model registry these tests run against.
 *
 * `models.json` is a projection of `config.yaml`'s `models:` block, so the
 * registry is declared here rather than hand-written to disk — injecting it
 * also keeps the environment from projecting the developer's real config
 * into the sandbox.
 */
function hermeticConfig(): YantraConfig {
  return {
    ...defaultConfig(),
    models: [
      {
        id: 'test-model',
        provider: 'testprov',
        base_url: 'http://127.0.0.1:9/v1',
        api_key: null,
        input: ['text'],
      },
    ],
  };
}

async function makeSmokeFixture(): Promise<{
  dataDir: string;
  runDir: string;
  cwd: string;
  config: YantraConfig;
}> {
  const dataDir = await makeTempDir('yantra-smoke-data-');
  const runDir = await makeTempDir('yantra-smoke-run-');
  const cwd = await makeTempDir('yantra-smoke-cwd-');
  return { dataDir, runDir, cwd, config: hermeticConfig() };
}

function statusToolEvents(): AgentSessionEvent[] {
  return [
    {
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'status',
      args: {},
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'status',
      result: { content: [{ type: 'text', text: '{"ok":true}' }], details: { ok: true } },
      isError: false,
    },
    {
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Status OK.' }],
          api: 'openai-completions',
          provider: 'testprov',
          model: 'test-model',
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: 0,
        },
      ],
      willRetry: false,
    } as AgentSessionEvent,
  ];
}

describe('@no-llm runAgentSmoke', () => {
  it('no-credential environment fails typed with AGENT_AUTH_UNAVAILABLE — no fallback constructed', async () => {
    const fixture = await makeSmokeFixture();
    let factoryCalls = 0;

    const attempt = runAgentSmoke({
      model: { provider: 'testprov', id: 'test-model' },
      runId: 'smoke-1',
      runDir: fixture.runDir,
      cwd: fixture.cwd,
      dataDir: fixture.dataDir,
      config: fixture.config,
      createSession: () => {
        factoryCalls += 1;
        throw new Error('unreachable');
      },
    });

    await expect(attempt).rejects.toBeInstanceOf(AgentAuthUnavailableError);
    await expect(attempt).rejects.toMatchObject({ code: 'AGENT_AUTH_UNAVAILABLE' });
    expect(factoryCalls).toBe(0);
  });

  it('unknown model id fails typed with AGENT_MODEL_NOT_FOUND', async () => {
    const fixture = await makeSmokeFixture();

    const attempt = runAgentSmoke({
      model: { provider: 'testprov', id: 'ghost-model' },
      auth: { mode: 'runtime-key', secretRef: 'testprov/key' },
      resolveSecret: () => Promise.resolve('sk-testKeyAbCdEfGhIjKlMn'),
      runId: 'smoke-2',
      runDir: fixture.runDir,
      cwd: fixture.cwd,
      dataDir: fixture.dataDir,
      config: fixture.config,
    });

    await expect(attempt).rejects.toBeInstanceOf(AgentModelNotFoundError);
  });

  it('registers exactly the status tool, streams events, and reports the round-trip', async () => {
    const fixture = await makeSmokeFixture();
    let captured: { tools?: string[]; customTools?: { name?: string }[]; noTools?: string } = {};

    const stubListeners: ((event: AgentSessionEvent) => void)[] = [];
    const stub: PiSessionLike = {
      sessionId: 'smoke-session',
      subscribe: (listener) => {
        stubListeners.push(listener);
        return () => undefined;
      },
      prompt: () => {
        for (const event of statusToolEvents()) {
          for (const listener of stubListeners) {
            listener(event);
          }
        }
        return Promise.resolve();
      },
      abort: () => Promise.resolve(),
      dispose: () => undefined,
    };

    const streamed: AgentEvent[] = [];
    const report = await runAgentSmoke({
      model: { provider: 'testprov', id: 'test-model' },
      auth: { mode: 'runtime-key', secretRef: 'testprov/key' },
      resolveSecret: () => Promise.resolve('sk-testKeyAbCdEfGhIjKlMn'),
      runId: 'smoke-3',
      runDir: fixture.runDir,
      cwd: fixture.cwd,
      dataDir: fixture.dataDir,
      config: fixture.config,
      onEvent: (event) => streamed.push(event),
      createSession: (sessionOptions) => {
        captured = sessionOptions as typeof captured;
        return Promise.resolve({ session: stub });
      },
    });

    // Built-ins disabled; the allowlist is exactly the status tool.
    expect(captured.noTools).toBe('all');
    expect(captured.tools).toEqual(['status']);
    expect((captured.customTools ?? []).map((tool) => tool.name)).toEqual(['status']);

    expect(report.result.outcome).toBe('completed');
    expect(report.statusToolInvoked).toBe(true);
    expect(report.sessionId).toBe('smoke-session');
    expect(report.logPath.replace(/\\/g, '/')).toContain(
      `${fixture.runDir.replace(/\\/g, '/')}/agent/`,
    );
    expect(streamed.map((event) => event.type)).toEqual(['tool_started', 'tool_finished']);

    // Enumeration evidence: pinned paths, zero ambient resources.
    expect(report.enumeration.extensions).toEqual([]);
    expect(report.enumeration.skills).toEqual([]);
    expect(report.enumeration.contextFiles).toEqual([]);
    expect(report.enumeration.settingsSource).toBe('in-memory');
  });

  it('an abort signal during the run yields a clean aborted outcome', async () => {
    const fixture = await makeSmokeFixture();
    const controller = new AbortController();

    let releasePrompt: () => void = () => undefined;
    let abortCalls = 0;
    const stub: PiSessionLike = {
      sessionId: 'smoke-abort',
      subscribe: () => () => undefined,
      prompt: () =>
        new Promise<void>((resolve) => {
          releasePrompt = resolve;
          // Simulate Ctrl+C arriving while the provider is streaming.
          queueMicrotask(() => controller.abort());
        }),
      abort: () => {
        abortCalls += 1;
        releasePrompt();
        return Promise.resolve();
      },
      dispose: () => undefined,
    };

    const report = await runAgentSmoke({
      model: { provider: 'testprov', id: 'test-model' },
      auth: { mode: 'runtime-key', secretRef: 'testprov/key' },
      resolveSecret: () => Promise.resolve('sk-testKeyAbCdEfGhIjKlMn'),
      runId: 'smoke-4',
      runDir: fixture.runDir,
      cwd: fixture.cwd,
      dataDir: fixture.dataDir,
      config: fixture.config,
      signal: controller.signal,
      createSession: () => Promise.resolve({ session: stub }),
    });

    expect(abortCalls).toBe(1);
    expect(report.result.outcome).toBe('aborted');
    expect(report.statusToolInvoked).toBe(false);
  });
});
