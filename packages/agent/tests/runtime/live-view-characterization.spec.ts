/**
 * FEAT-069 TASK-007 characterization: a live view never changes a run.
 *
 * The same scripted `do` runs twice against a real Chrome and a local site,
 * once with no live view and once with a live-view hub whose client is
 * started and acks every frame. The run directories must hold the same files
 * with the same contents once volatile values (timestamps, durations, ids,
 * paths) are normalized, and the second run must really have streamed frames.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import {
  BlocklistImpl,
  DEFAULT_SEARCH_CONFIG,
  LiveViewHub,
  LocalBrowserProvider,
  LocalProfileStore,
  defaultEthicsConfig,
  resetPathCache,
  type KeychainProvider,
} from '@yantra/core';
import { LocalRunStore } from '@yantra/core/workflow/replay';
import type { ConfirmationRequest } from '@yantra/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { auditProjectionOf, buildYantraWrappedTools } from '../../src/adapters/pi/tools/index.js';
import type {
  AgentEvent,
  AgentProvider,
  AgentRunResult,
  AgentSession,
} from '../../src/provider/index.js';
import type { AgentProgressEvent, AgentTaskConnector } from '../../src/runtime/connector.js';
import { runAgenticTask } from '../../src/runtime/orchestrator.js';
import type { AgenticTaskOutcome } from '../../src/runtime/outcome.js';
import { COMMAND_TASK_PROFILES } from '../../src/runtime/profiles.js';
import type { RunServices } from '../../src/runtime/run-services.js';

class SilentConnector implements AgentTaskConnector {
  public readonly interactive = false;

  public requestConfirmation(_request: ConfirmationRequest): Promise<'granted'> {
    return Promise.resolve('granted');
  }

  public emitAgentEvent(_event: AgentProgressEvent): void {
    // Not what this test asserts.
  }

  public renderAgentOutcome(_outcome: AgenticTaskOutcome): void {
    // Not what this test asserts.
  }
}

type Step =
  | { readonly tool: string; readonly params: Record<string, unknown> }
  | { readonly wait: () => Promise<void> };

/** Runs the plan through the run's own wrapped tools, then publishes. */
class ScriptedProvider implements AgentProvider {
  public constructor(
    private readonly services: RunServices,
    private readonly plan: readonly Step[],
  ) {}

  public open(options: { readonly runDir: string }): Promise<AgentSession> {
    const tools = new Map(buildYantraWrappedTools(this.services).map((tool) => [tool.name, tool]));
    const listeners = new Set<(event: AgentEvent) => void>();
    const emit = (event: AgentEvent): void => {
      for (const listener of listeners) listener(event);
    };
    let runs = 0;
    let calls = 0;
    const session: AgentSession = {
      id: 'live-view-session',
      logPath: `${options.runDir}/agent/live-view-session.jsonl`,
      authSource: 'managed',
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      steer: () => Promise.resolve('idle'),
      abort: () => Promise.resolve(),
      close: () => Promise.resolve(),
      run: async (): Promise<AgentRunResult> => {
        const steps: readonly Step[] =
          runs++ === 0
            ? this.plan
            : [
                {
                  tool: 'result_publish',
                  params: { brief: { title: 'Live view', overview: 'Both pages were visited.' } },
                },
              ];
        for (const step of steps) {
          if ('wait' in step) {
            await step.wait();
            continue;
          }
          const tool = tools.get(step.tool);
          if (tool === undefined) throw new Error(`absent tool ${step.tool}`);
          const callId = `call-${(calls += 1)}`;
          emit({
            type: 'tool_started',
            callId,
            tool: step.tool,
            input: step.params,
            at: new Date().toISOString(),
          });
          const result = await tool.execute(step.params, undefined);
          emit({
            type: 'tool_finished',
            callId,
            tool: step.tool,
            output: auditProjectionOf(result),
            isError: result.status !== 'ok',
            at: new Date().toISOString(),
          });
        }
        return { outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } };
      },
    };
    return Promise.resolve(session);
  }
}

function memoryKeychain(): KeychainProvider {
  return {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(false),
    list: () => Promise.resolve([]),
    isAvailable: () => Promise.resolve(true),
  };
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/gu;
const VOLATILE_KEY =
  /(?:^|_)(?:at|ms)$|At$|Ms$|^(?:ts|time|timestamp|duration|elapsed|pid|hostname|startToken|v)$/u;

/** Normalizes one artifact's text so two runs of the same plan compare equal. */
function normalize(text: string, runId: string, runDir: string): string {
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      // A budget dimension in milliseconds measures time, not behavior.
      const timed = record.unit === 'ms';
      return Object.fromEntries(
        Object.entries(record)
          .filter(([key]) => !VOLATILE_KEY.test(key) && !(timed && key === 'used'))
          .map(([key, inner]) => [key, scrub(inner)]),
      );
    }
    return typeof value === 'string' ? scrubText(value) : value;
  };
  const scrubText = (value: string): string =>
    value
      .replaceAll(runDir, '<runDir>')
      .replaceAll(runDir.split(sep).join('/'), '<runDir>')
      .replaceAll(runId, '<runId>')
      .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/gu, '<ulid>')
      .replace(ISO, '<ts>')
      .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/gu, '<duration>')
      .replace(/127\.0\.0\.1:\d+/gu, '127.0.0.1:<port>')
      // The two runs' roots, however deeply a path to them is escaped.
      .replace(/runs-[ab]/gu, 'runs-x');
  const lines = text.split('\n');
  const parsed = lines.map((line) => {
    try {
      return JSON.stringify(scrub(JSON.parse(line)));
    } catch {
      return null;
    }
  });
  if (parsed.every((line, index) => line !== null || lines[index] === '')) {
    return parsed.join('\n');
  }
  try {
    return JSON.stringify(scrub(JSON.parse(text)));
  } catch {
    return scrubText(text);
  }
}

function snapshot(runDir: string, runId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(runDir, { recursive: true, encoding: 'utf8' })) {
    const path = join(runDir, entry);
    if (!statSync(path).isFile()) continue;
    const name = relative(runDir, path).split(sep).join('/');
    // The operator diagnostic log differs by environment alone: the first run
    // records a one-time browser compatibility probe, and session ids are random.
    if (name === 'runtime.jsonl') continue;
    out[name] = normalize(readFileSync(path, 'utf8'), runId, runDir);
  }
  return out;
}

describe('@no-llm live view characterization (real Chrome)', () => {
  let root: string;
  let server: Server;
  let baseUrl: string;
  let previousHome: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-live-view-char-'));
    previousHome = process.env.YANTRA_HOME;
    process.env.YANTRA_HOME = join(root, 'home');
    resetPathCache();
    server = createServer((request, response) => {
      const second = request.url === '/second';
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<!doctype html><title>${second ? 'Second' : 'First'}</title><main><h1>${
            second ? 'Second page' : 'First page'
          }</h1><style>@keyframes s{to{opacity:.2}}h1{animation:s .5s infinite alternate}</style></main>`,
        );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = previousHome;
    resetPathCache();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  async function run(liveView: LiveViewHub | undefined, wait: () => Promise<void>) {
    // Equal-length roots: run paths reach a model-visible result, and its byte count.
    const runsRoot = join(root, liveView === undefined ? 'runs-a' : 'runs-b');
    const outcome = await runAgenticTask(
      {
        goal: `Visit ${baseUrl}/ and ${baseUrl}/second and report`,
        profile: COMMAND_TASK_PROFILES.do,
        model: { provider: 'fixture', id: 'fixture-model' },
        auth: { mode: 'managed' },
        connector: new SilentConnector(),
        ...(liveView === undefined ? {} : { liveView }),
      },
      {
        runStore: new LocalRunStore(runsRoot),
        urlPolicyConfig: { maxUrlLength: 2048, requireHttps: false },
        environmentLeaves: {
          keychain: memoryKeychain(),
          ethicsConfig: { ...defaultEthicsConfig, robotsEnabled: false },
          searchConfig: DEFAULT_SEARCH_CONFIG,
          blocklist: new BlocklistImpl(),
          createBrowserProvider: (options) =>
            new LocalBrowserProvider({
              profileStore: new LocalProfileStore(),
              ...(options.logger === undefined ? {} : { logger: options.logger }),
            }),
        },
        createProvider: (services) =>
          new ScriptedProvider(services, [
            { tool: 'task_contract', params: { deliverable: 'report', subject: 'Two pages' } },
            { tool: 'browser_navigate', params: { url: `${baseUrl}/` } },
            { wait },
            { tool: 'browser_navigate', params: { url: `${baseUrl}/second` } },
            { wait },
          ]),
      },
    );
    return outcome;
  }

  it('writes the same artifacts with and without a started live-view client', async () => {
    const plain = await run(undefined, () => Promise.resolve());

    const hub = new LiveViewHub();
    let received = 0;
    let waiting: (() => void) | null = null;
    const client = hub.addClient({
      control: () => undefined,
      frame: (meta) => {
        received += 1;
        waiting?.();
        client.ack({ generation: meta.generation, frame_seq: meta.frame_seq });
      },
    });
    client.start({ max_width: 640, max_height: 400 });
    const waitForFrame = async (): Promise<void> => {
      const target = received + 1;
      const deadline = Date.now() + 10_000;
      while (received < target && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          waiting = resolve;
          setTimeout(resolve, 50);
        });
      }
    };
    const watched = await run(hub, waitForFrame);
    await hub.close();

    expect(received).toBeGreaterThanOrEqual(2);
    expect(watched.kind).toBe(plain.kind);
    const before = snapshot(plain.runDir, plain.runId);
    const after = snapshot(watched.runDir, watched.runId);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const name of Object.keys(before)) {
      expect({ name, content: after[name] }).toEqual({ name, content: before[name] });
    }
  }, 120_000);
});
