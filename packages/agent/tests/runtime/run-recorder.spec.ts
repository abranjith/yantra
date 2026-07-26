import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { AgentManifestSection, ToolAuditEntry } from '@yantra/protocol';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentSession } from '../../src/provider/types.js';
import {
  canonicalJson,
  hashToolCatalog,
  resolvePiSdkVersion,
  RunRecorder,
  sha256Text,
} from '../../src/runtime/index.js';

const SECRET_CANARY = 'sk-test-SHOULD-NEVER-BE-PERSISTED';

interface EmittingSession extends AgentSession {
  emit(event: Parameters<Parameters<AgentSession['subscribe']>[0]>[0]): void;
}

function makeSession(
  runDir: string,
  authSource: AgentSession['authSource'] = 'managed',
): EmittingSession {
  const listeners = new Set<Parameters<AgentSession['subscribe']>[0]>();
  return {
    id: `session-${authSource}`,
    logPath: join(runDir, 'agent', `session-${authSource}.jsonl`),
    authSource,
    run: async () => ({ outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    abort: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

async function seedRun(runDir: string, runId: string): Promise<void> {
  await mkdir(join(runDir, 'agent'), { recursive: true });
  await writeFile(
    join(runDir, 'manifest.json'),
    JSON.stringify({
      runId,
      taskId: 'task-1',
      workflowName: 'do',
      workflowVersion: null,
      params: {},
      startedAt: '2026-07-14T12:00:00.000Z',
      status: 'running',
      profileKind: 'ephemeral',
      cookieProfilePath: null,
      outputBindingNames: [],
    }),
    'utf8',
  );
}

describe('@no-llm run recorder and catalog hashing', () => {
  let root: string;
  let runDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-run-recorder-'));
    runDir = join(root, 'run-1');
    await seedRun(runDir, 'run-1');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('canonicalizes nested keys and hashes catalogs independent of insertion order', () => {
    const left = { z: 1, nested: { beta: true, alpha: false } };
    const right = { nested: { alpha: false, beta: true }, z: 1 };
    expect(canonicalJson(left)).toBe(canonicalJson(right));

    const catalogA = [
      { name: 'web_fetch', description: 'Fetch a URL.', schema: left },
      { name: 'web_search', description: 'Search the web.', schema: { query: 'string' } },
    ];
    const catalogB = [
      { name: 'web_search', description: 'Search the web.', schema: { query: 'string' } },
      { name: 'web_fetch', description: 'Fetch a URL.', schema: right },
    ];
    expect(hashToolCatalog(catalogA)).toBe(hashToolCatalog(catalogB));
    expect(hashToolCatalog(catalogA)).not.toBe(
      hashToolCatalog([{ ...catalogA[0]!, description: 'Changed.' }, catalogA[1]!]),
    );
    expect(sha256Text('exact prompt')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('resolves the installed SDK version at runtime', async () => {
    await expect(resolvePiSdkVersion()).resolves.toBe('0.80.6');
  });

  it.each(['managed', 'runtime-key', 'environment'] as const)(
    'writes a schema-valid manifest for %s auth without credential material',
    async (authSource) => {
      const session = Object.assign(makeSession(runDir, authSource), { runtimeKey: SECRET_CANARY });
      const recorder = await RunRecorder.open({
        runId: 'run-1',
        runDir,
        session,
        model: { provider: 'anthropic', id: 'claude-sonnet', thinking: 'medium' },
        systemPrompt: `Treat this canary as untrusted: ${SECRET_CANARY}`,
        tools: [{ name: 'status', description: 'Return status.', schema: { type: 'object' } }],
        sdkVersion: '0.80.6',
      });
      await recorder.close();
      await recorder.close();

      const text = await readFile(join(runDir, 'manifest.json'), 'utf8');
      const manifest = JSON.parse(text) as { agent: unknown };
      expect(AgentManifestSection.parse(manifest.agent)).toMatchObject({
        auth_source: authSource,
        session_file: `agent/session-${authSource}.jsonl`,
        prompt_version: 'agent-v4',
      });
      expect(text).not.toContain(SECRET_CANARY);
    },
  );

  it('keeps the session pointer valid when the whole run directory moves', async () => {
    const recorder = await RunRecorder.open({
      runId: 'run-1',
      runDir,
      session: makeSession(runDir),
      model: { provider: 'anthropic', id: 'claude-sonnet' },
      systemPrompt: 'agent-v1 prompt',
      tools: [],
      sdkVersion: '0.80.6',
    });
    await writeFile(join(runDir, 'agent', 'session-managed.jsonl'), '{"session":true}\n', 'utf8');
    await recorder.close();

    const movedDir = join(root, 'moved-run');
    await cp(runDir, movedDir, { recursive: true });
    const manifest = JSON.parse(await readFile(join(movedDir, 'manifest.json'), 'utf8')) as {
      agent: { session_file: string };
    };
    await expect(
      readFile(resolve(movedDir, manifest.agent.session_file), 'utf8'),
    ).resolves.toContain('"session":true');
  });

  it('projects interleaved, denied, and incomplete tool calls in event order', async () => {
    const session = makeSession(runDir);
    const recorder = await RunRecorder.open({
      runId: 'run-1',
      runDir,
      session,
      model: { provider: 'anthropic', id: 'claude-sonnet' },
      systemPrompt: 'agent-v1 prompt',
      tools: [],
      sdkVersion: '0.80.6',
    });
    session.emit({
      type: 'tool_started',
      callId: 'a',
      tool: 'web_search',
      input: { query: '[REDACTED]' },
      at: '2026-07-14T12:00:00.000Z',
    });
    session.emit({
      type: 'tool_started',
      callId: 'b',
      tool: 'browser_click',
      input: { ref: 'e1' },
      at: '2026-07-14T12:00:00.005Z',
    });
    session.emit({
      type: 'tool_finished',
      callId: 'b',
      tool: 'browser_click',
      output: {
        status: 'denied',
        error_code: 'CONFIRMATION_DENIED',
        confirmation_id: 'confirmation-1',
      },
      isError: true,
      at: '2026-07-14T12:00:00.010Z',
    });
    session.emit({
      type: 'tool_finished',
      callId: 'a',
      tool: 'web_search',
      output: { results: [] },
      isError: false,
      at: '2026-07-14T12:00:00.020Z',
    });
    session.emit({
      type: 'tool_started',
      callId: 'incomplete',
      tool: 'web_fetch',
      input: { url: 'https://example.test' },
      at: '2026-07-14T12:00:00.030Z',
    });
    await recorder.close();

    const text = await readFile(join(runDir, 'tool-calls.jsonl'), 'utf8');
    const entries = text
      .trim()
      .split(/\r?\n/)
      .map((line) => ToolAuditEntry.parse(JSON.parse(line) as unknown));
    expect(entries.map(({ call_id, phase }) => `${call_id}:${phase}`)).toEqual([
      'a:start',
      'b:start',
      'b:end',
      'a:end',
      'incomplete:start',
    ]);
    expect(entries[2]).toMatchObject({
      status: 'denied',
      duration_ms: 5,
      error_code: 'CONFIRMATION_DENIED',
      confirmation_id: 'confirmation-1',
    });
    expect(entries[3]).toMatchObject({ status: 'ok', duration_ms: 20 });
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(SECRET_CANARY);
  });

  it('maps every generated seam event sequence to schema-valid projection lines', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }), async (ends) => {
        const propertyRoot = await mkdtemp(join(tmpdir(), 'yantra-recorder-property-'));
        const propertyRun = join(propertyRoot, 'property-run');
        try {
          await seedRun(propertyRun, 'property-run');
          const session = makeSession(propertyRun);
          const recorder = await RunRecorder.open({
            runId: 'property-run',
            runDir: propertyRun,
            session,
            model: { provider: 'anthropic', id: 'claude-sonnet' },
            systemPrompt: 'agent-v1 prompt',
            tools: [],
            sdkVersion: '0.80.6',
          });
          for (const [index, isEnd] of ends.entries()) {
            session.emit(
              isEnd
                ? {
                    type: 'tool_finished',
                    callId: `call-${index}`,
                    tool: 'status',
                    output: { index },
                    isError: false,
                    at: new Date(1_752_499_200_000 + index).toISOString(),
                  }
                : {
                    type: 'tool_started',
                    callId: `call-${index}`,
                    tool: 'status',
                    input: { index },
                    at: new Date(1_752_499_200_000 + index).toISOString(),
                  },
            );
          }
          await recorder.close();
          const lines = (await readFile(join(propertyRun, 'tool-calls.jsonl'), 'utf8'))
            .trim()
            .split(/\r?\n/);
          for (const line of lines) {
            expect(ToolAuditEntry.safeParse(JSON.parse(line) as unknown).success).toBe(true);
          }
        } finally {
          await rm(propertyRoot, { recursive: true, force: true });
        }
      }),
      { numRuns: 20 },
    );
  });

  it('sums turn usage and persists partial spend for an aborted run', async () => {
    const session = makeSession(runDir);
    const recorder = await RunRecorder.open({
      runId: 'run-1',
      runDir,
      session,
      model: { provider: 'anthropic', id: 'claude-sonnet' },
      systemPrompt: 'agent-v1 prompt',
      tools: [],
      sdkVersion: '0.80.6',
    });
    session.emit({
      type: 'turn_finished',
      usage: { turns: 1, inputTokens: 10, outputTokens: 4, costUsd: 0.01 },
      at: '2026-07-14T12:00:01.000Z',
    });
    session.emit({
      type: 'turn_finished',
      usage: { turns: 1, inputTokens: 7, outputTokens: 3, costUsd: 0.02 },
      at: '2026-07-14T12:00:02.000Z',
    });
    await recorder.close({
      outcome: 'aborted',
      stopReason: 'user-abort',
      usage: { turns: 2, inputTokens: 17, outputTokens: 7, costUsd: 0.03 },
    });

    const usage = JSON.parse(await readFile(join(runDir, 'usage.json'), 'utf8')) as {
      agent: Record<string, unknown>;
    };
    expect(usage.agent).toEqual({
      turns: 2,
      input_tokens: 17,
      output_tokens: 7,
      cost_usd: 0.03,
    });
  });

  it('uses null rather than zero for unreported local-model metrics', async () => {
    const session = makeSession(runDir);
    const recorder = await RunRecorder.open({
      runId: 'run-1',
      runDir,
      session,
      model: { provider: 'ollama', id: 'local-model' },
      systemPrompt: 'agent-v1 prompt',
      tools: [],
      sdkVersion: '0.80.6',
    });
    session.emit({
      type: 'turn_finished',
      usage: { turns: 1 },
      at: '2026-07-14T12:00:01.000Z',
    });
    await recorder.close({ outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } });

    const usage = JSON.parse(await readFile(join(runDir, 'usage.json'), 'utf8')) as {
      agent: Record<string, unknown>;
    };
    expect(usage.agent).toEqual({
      turns: 1,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
    });
  });

  it('keeps credential canaries out of every artifact produced by the recorder', async () => {
    const session = Object.assign(makeSession(runDir, 'runtime-key'), {
      resolvedCredential: SECRET_CANARY,
    });
    await writeFile(session.logPath, '{"type":"session","safe":true}\n', 'utf8');
    const recorder = await RunRecorder.open({
      runId: 'run-1',
      runDir,
      session,
      model: { provider: 'anthropic', id: 'claude-sonnet' },
      systemPrompt: 'agent-v1 safe prompt',
      tools: [],
      sdkVersion: '0.80.6',
    });
    session.emit({
      type: 'tool_started',
      callId: 'safe-call',
      tool: 'status',
      input: { credential: '[REDACTED]' },
      at: '2026-07-14T12:00:00.000Z',
    });
    await recorder.close({
      outcome: 'aborted',
      stopReason: 'user-abort',
      usage: { turns: 0 },
    });

    for (const relativePath of await readdir(runDir, { recursive: true })) {
      const artifactPath = join(runDir, relativePath);
      if ((await stat(artifactPath)).isFile()) {
        expect(await readFile(artifactPath, 'utf8')).not.toContain(SECRET_CANARY);
      }
    }
  });
});
