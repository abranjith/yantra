import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  AgentManifestSection,
  ToolAuditEntry,
  UsageLedger,
  type UsageLedger as UsageLedgerType,
} from '@yantra/protocol';
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
        prompt_version: 'agent-v12',
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
      output: {
        results: [],
        details: {
          applied: [
            { field: 'Choice', attempted: [{ strategy: 'clear-then-type', verdict: 'succeeded' }] },
          ],
        },
      },
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
    expect(entries[3]).toMatchObject({
      status: 'ok',
      duration_ms: 20,
      output_sanitized: {
        details: {
          applied: [{ attempted: [{ strategy: 'clear-then-type', verdict: 'succeeded' }] }],
        },
      },
    });
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

describe('@no-llm run recorder — one usage call per provider turn (FEAT-048)', () => {
  let root: string;
  let runDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-run-recorder-usage-'));
    runDir = join(root, 'run-1');
    await seedRun(runDir, 'run-1');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function openRecorder(provider: string) {
    const session = makeSession(runDir);
    const recorder = await RunRecorder.open({
      runId: 'run-1',
      runDir,
      session,
      model: { provider, id: 'model-x' },
      systemPrompt: 'agent prompt',
      tools: [],
      sdkVersion: '0.80.6',
      now: () => new Date('2026-07-14T12:00:00.000Z'),
    });
    return { session, recorder };
  }

  async function readLedger(): Promise<UsageLedgerType> {
    return UsageLedger.parse(JSON.parse(await readFile(join(runDir, 'usage.json'), 'utf8')));
  }

  it('writes one call per turn whose totals agree with the agent block', async () => {
    const { session, recorder } = await openRecorder('anthropic');
    const turns = [
      { at: '2026-07-14T12:00:02.000Z', inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
      { at: '2026-07-14T12:00:05.500Z', inputTokens: 150, outputTokens: 30, costUsd: 0.02 },
      { at: '2026-07-14T12:00:06.000Z', inputTokens: 50, outputTokens: 10, costUsd: 0.005 },
    ];
    for (const turn of turns) {
      session.emit({
        type: 'turn_finished',
        usage: {
          turns: 1,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          costUsd: turn.costUsd,
        },
        at: turn.at,
      });
    }
    await recorder.close({ outcome: 'completed', stopReason: 'stop', usage: { turns: 3 } });

    const ledger = await readLedger();
    expect(ledger.calls).toEqual([
      {
        step_id: 'turn-1',
        model: 'model-x',
        provider: 'anthropic',
        input_tokens: 100,
        output_tokens: 20,
        cost_estimate_usd: 0.01,
        latency_ms: 2000,
        at: '2026-07-14T12:00:02.000Z',
      },
      expect.objectContaining({ step_id: 'turn-2', latency_ms: 3500 }),
      expect.objectContaining({ step_id: 'turn-3', latency_ms: 500 }),
    ]);
    expect(ledger.totals.input_tokens).toBe(ledger.agent?.input_tokens);
    expect(ledger.totals.output_tokens).toBe(ledger.agent?.output_tokens);
    expect(ledger.totals.cost_estimate_usd).toBeCloseTo(ledger.agent?.cost_usd ?? -1, 10);
    expect(ledger.totals.call_count).toBe(3);
    expect(ledger.agent?.turns).toBe(3);
  });

  it('reports a null total cost when any turn lacks cost, leaving the agent block unchanged', async () => {
    const { session, recorder } = await openRecorder('anthropic');
    session.emit({
      type: 'turn_finished',
      usage: { turns: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.01 },
      at: '2026-07-14T12:00:01.000Z',
    });
    session.emit({
      type: 'turn_finished',
      usage: { turns: 1, inputTokens: 5, outputTokens: 1 },
      at: '2026-07-14T12:00:02.000Z',
    });
    await recorder.close({
      outcome: 'completed',
      stopReason: 'stop',
      usage: { turns: 2, inputTokens: 15, outputTokens: 3, costUsd: 0.04 },
    });

    const ledger = await readLedger();
    expect(ledger.calls[1]?.cost_estimate_usd).toBeNull();
    expect(ledger.totals.cost_estimate_usd).toBeNull();
    expect(ledger.agent?.cost_usd).toBe(0.04);
  });

  it('records zero tokens for a turn whose provider reported no usage', async () => {
    const { session, recorder } = await openRecorder('ollama');
    session.emit({ type: 'turn_finished', usage: { turns: 1 }, at: '2026-07-14T12:00:01.000Z' });
    await recorder.close({ outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } });

    const ledger = await readLedger();
    expect(ledger.calls).toEqual([
      expect.objectContaining({ input_tokens: 0, output_tokens: 0, cost_estimate_usd: null }),
    ]);
    expect(ledger.agent?.input_tokens).toBeNull();
  });

  it('accepts a registry provider outside the old closed enum (groq)', async () => {
    const { session, recorder } = await openRecorder('groq');
    session.emit({
      type: 'turn_finished',
      usage: { turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
      at: '2026-07-14T12:00:01.000Z',
    });
    await recorder.close({ outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } });

    expect((await readLedger()).calls[0]?.provider).toBe('groq');
  });

  it('clamps latency to zero for a turn timestamp earlier than its baseline', async () => {
    const { session, recorder } = await openRecorder('anthropic');
    session.emit({ type: 'turn_finished', usage: { turns: 1 }, at: '2026-07-14T11:59:59.000Z' });
    session.emit({ type: 'turn_finished', usage: { turns: 1 }, at: '2026-07-14T12:00:01.250Z' });
    await recorder.close({ outcome: 'completed', stopReason: 'stop', usage: { turns: 2 } });

    const ledger = await readLedger();
    expect(ledger.calls.map((call) => call.latency_ms)).toEqual([0, 2250]);
  });

  it('still validates an old agentic usage.json with calls: [] and an agent block', () => {
    const old = {
      run_id: 'old-run',
      calls: [],
      totals: { input_tokens: 0, output_tokens: 0, cost_estimate_usd: 0, call_count: 0 },
      agent: { turns: 15, input_tokens: 90000, output_tokens: 4000, cost_usd: 0.165 },
    };

    expect(UsageLedger.safeParse(old).success).toBe(true);
  });
});
