// @no-llm
/**
 * FEAT-069 TASK-007 characterization, replay side: a fixture `run` workflow
 * writes the same artifacts with and without a started live-view client, and
 * the watched run really streamed frames.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { ok, type WorkflowFile } from '@yantra/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetPathCache } from '../../src/browser/paths.js';
import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import type { Logger } from '../../src/browser/types.js';
import { LiveViewHub } from '../../src/live-view/live-view-hub.js';
import { RunOrchestrator } from '../../src/workflow/replay/run-orchestrator.js';
import { LocalRunStore } from '../../src/workflow/replay/run-store.js';
import type { WorkflowStore } from '../../src/workflow/store.types.js';

const silent: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function workflow(baseUrl: string): WorkflowFile {
  const navigate = (id: string, url: string) => ({
    id,
    verb: 'navigate' as const,
    scope: null,
    requires_confirmation: false,
    confirmation_description: null,
    expected_cost: null,
    consequence: null,
    url,
  });
  return {
    version: 1,
    name: 'live-view-fixture',
    description: null,
    security_class: 'public',
    recorded_with: null,
    params: {},
    secrets: [],
    cookies: 'none',
    steps: [
      navigate('first', `${baseUrl}/`),
      navigate('second', `${baseUrl}/second`),
      // Paces the run so capture has started even on a loaded machine.
      {
        id: 'ready',
        verb: 'wait_for' as const,
        scope: null,
        requires_confirmation: false,
        confirmation_description: null,
        expected_cost: null,
        consequence: null,
        locator: 'Ready',
        state: 'visible' as const,
        timeout_ms: 15_000,
      },
    ],
    outputs: [],
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: { Ready: [{ kind: 'css' as const, value: '#ready' }] },
  } as WorkflowFile;
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/gu;
const VOLATILE_KEY = /(?:^|_)(?:at|ms)$|At$|Ms$|^(?:ts|duration|elapsed)$/u;

function normalize(text: string, runId: string, runDir: string): string {
  const scrubText = (value: string): string =>
    value
      .replaceAll(runDir, '<runDir>')
      .replaceAll(runId, '<runId>')
      .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/gu, '<ulid>')
      .replace(ISO, '<ts>')
      .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/gu, '<duration>')
      .replace(/runs-[ab]/gu, 'runs-x');
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !VOLATILE_KEY.test(key))
          .map(([key, inner]) => [key, scrub(inner)]),
      );
    }
    return typeof value === 'string' ? scrubText(value) : value;
  };
  const lines = text.split('\n');
  const parsed = lines.map((line) => {
    try {
      return JSON.stringify(scrub(JSON.parse(line)));
    } catch {
      return null;
    }
  });
  if (parsed.every((line, index) => line !== null || lines[index] === '')) return parsed.join('\n');
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
    out[relative(runDir, path).split(sep).join('/')] = normalize(
      readFileSync(path, 'utf8'),
      runId,
      runDir,
    );
  }
  return out;
}

describe('@no-llm replay live view characterization (real Chrome)', () => {
  let root: string;
  let server: Server;
  let baseUrl: string;
  let previousHome: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-replay-live-view-'));
    previousHome = process.env.YANTRA_HOME;
    process.env.YANTRA_HOME = join(root, 'home');
    resetPathCache();
    server = createServer((request, response) => {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<!doctype html><title>${request.url === '/second' ? 'Second' : 'First'}</title>` +
            '<style>@keyframes s{to{opacity:.2}}h1{animation:s .2s infinite alternate}</style><h1>Fixture</h1>' +
            "<script>setTimeout(()=>{const p=document.createElement('p');p.id='ready';p.textContent='ready';document.body.appendChild(p)},1500)</script>",
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

  async function run(name: 'runs-a' | 'runs-b', liveView: LiveViewHub | null) {
    const orchestrator = new RunOrchestrator({
      workflowStore: {
        load: () => Promise.resolve(ok(workflow(baseUrl))),
      } as unknown as WorkflowStore,
      runStore: new LocalRunStore(join(root, name)),
      browserProvider: new LocalBrowserProvider({
        profileStore: new LocalProfileStore(),
        logger: silent,
      }),
      keychain: {} as never,
      ethicsGate: { check: () => Promise.resolve() },
      logger: silent,
      liveView,
    });
    const outcome = await orchestrator.run({
      workflowName: 'live-view-fixture',
      params: {},
      budgets: {},
      json: false,
      debug: false,
    });
    return { outcome, runDir: join(root, name, outcome.runId) };
  }

  it('writes the same artifacts with and without a started client, and tears the page down', async () => {
    const plain = await run('runs-a', null);

    const hub = new LiveViewHub();
    let frames = 0;
    const states: string[] = [];
    const client = hub.addClient({
      control: (message) => {
        if (message.type === 'frames.state') states.push(message.state);
      },
      frame: (meta) => {
        frames += 1;
        client.ack({ generation: meta.generation, frame_seq: meta.frame_seq });
      },
    });
    client.start({ max_width: 640, max_height: 400 });
    const watched = await run('runs-b', hub);
    await hub.idle();

    expect(plain.outcome.kind).toBe('success');
    expect(watched.outcome.kind).toBe('success');
    // The run's page was really streamed, then torn down before the browser closed.
    expect(states).toContain('live');
    expect(states.at(-1)).toBe('no_page');
    expect(hub.capturing).toBe(false);
    expect(frames).toBeGreaterThan(0);
    await hub.close();

    const before = snapshot(plain.runDir, plain.outcome.runId);
    const after = snapshot(watched.runDir, watched.outcome.runId);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const name of Object.keys(before)) {
      expect({ name, content: after[name] }).toEqual({ name, content: before[name] });
    }
  }, 120_000);
});
