/**
 * @no-llm The integrated FEAT-051 contract: shape-aware extraction with links.
 *
 * A scripted session drives the run's REAL wrapped tools through the default
 * environment composer, with only its leaves replaced: an HTTP transport that
 * serves fixture pages from a map and counts requests per URL, and a search
 * provider leaf. Each step picks its URL from what earlier results actually
 * offered — a facet from `links[]`, details from `records[]` — exactly as a
 * model must, so an unreachable move shows up as a missing URL rather than a
 * hard-coded one. Every assertion is made on the finished run (plan §7
 * "Target trace").
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  BlocklistImpl,
  DEFAULT_SEARCH_CONFIG,
  defaultEthicsConfig,
  resetPathCache,
  type BrowserProvider,
  type KeychainProvider,
  type SearchProvider,
} from '@yantra/core';
import { LocalRunStore } from '@yantra/core/workflow/replay';
import { ok, type ConfirmationRequest } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditProjectionOf, buildYantraWrappedTools } from '../../src/adapters/pi/tools/index.js';
import type {
  AgentEvent,
  AgentProvider,
  AgentRunResult,
  AgentSession,
} from '../../src/provider/index.js';
import type { AgentProgressEvent, AgentTaskConnector } from '../../src/runtime/connector.js';
import { runAgenticTask, type EnvironmentLeaves } from '../../src/runtime/orchestrator.js';
import { COMMAND_TASK_PROFILES } from '../../src/runtime/profiles.js';
import type { RunServices } from '../../src/runtime/run-services.js';
import { LISTING_SELLERS, detailHtml, listingHtml } from '../adapters/pi/tools/page-fixtures.js';

const ORIGIN = 'http://cars.example.test';
const LISTING = `${ORIGIN}/new/results`;
const UNATTESTED = `${ORIGIN}/vehicle/itm-77`;

/** The truth colors each detail page renders. */
const COLORS: Readonly<Record<string, readonly [string, string]>> = {
  'itm-01': ['Glacier White', 'Black Leather'],
  'itm-02': ['Harbor Blue', 'Gray Cloth'],
};

/** Every page the fixture host serves. */
function page(url: string): string | null {
  const { pathname, search } = new URL(url);
  if (pathname === '/new/results')
    return search === '' || search.includes('drivetrain') ? listingHtml() : null;
  const detail = /^\/vehicle\/(itm-0[12])$/u.exec(pathname);
  if (detail === null) return null;
  const [exterior, interior] = COLORS[detail[1] ?? ''] ?? ['', ''];
  const seller = LISTING_SELLERS[Number(detail[1]?.slice(-1)) - 1] ?? '';
  return detailHtml(exterior, interior, seller);
}

interface Received {
  readonly label: string;
  readonly tool: string;
  readonly status: string;
  readonly payload: Record<string, unknown>;
}

interface Step {
  readonly label: string;
  readonly tool: string;
  /** The params, resolved from earlier results; null when nothing offered the move. */
  readonly params: (prior: ReadonlyMap<string, Received>) => Record<string, unknown> | null;
}

const recordsOf = (received: Received | undefined): { id: string; url: string | null }[] =>
  (received?.payload.records as { id: string; url: string | null }[] | undefined) ?? [];

const SCRIPT: readonly Step[] = [
  { label: 'search', tool: 'web_search', params: () => ({ query: 'teyra listings', limit: 1 }) },
  { label: 'listing', tool: 'web_fetch', params: () => ({ url: LISTING }) },
  {
    label: 'facet',
    tool: 'web_fetch',
    params: (prior) => {
      const links = (prior.get('listing')?.payload.links ?? []) as {
        kind: string;
        text: string;
        url: string;
      }[];
      const facet = links.find((link) => link.kind === 'facet' && /^AWD\b/u.test(link.text));
      return facet === undefined ? null : { url: facet.url };
    },
  },
  ...[0, 1].map(
    (index): Step => ({
      label: `detail-${index + 1}`,
      tool: 'web_fetch',
      params: (prior) => {
        const url = recordsOf(prior.get('listing'))[index]?.url;
        return typeof url === 'string' ? { url } : null;
      },
    }),
  ),
  { label: 'guess', tool: 'web_fetch', params: () => ({ url: UNATTESTED }) },
  {
    label: 'publish',
    tool: 'result_publish',
    params: () => ({
      brief: { title: 'Teyra listings', overview: 'Read the listing and details.' },
    }),
  },
];

/** Drives the run's own wrapped tools, resolving each step against earlier results. */
class ScriptedProvider implements AgentProvider {
  public readonly results = new Map<string, Received>();
  public readonly unreachable: string[] = [];

  public constructor(public readonly services: RunServices) {}

  public open(options: { readonly runDir: string }): Promise<AgentSession> {
    const tools = new Map(buildYantraWrappedTools(this.services).map((tool) => [tool.name, tool]));
    const listeners = new Set<(event: AgentEvent) => void>();
    let calls = 0;
    const call = async (step: Step): Promise<void> => {
      const params = step.params(this.results);
      if (params === null) {
        this.unreachable.push(step.label);
        return;
      }
      const tool = tools.get(step.tool);
      if (tool === undefined) throw new Error(`absent tool ${step.tool}`);
      const callId = `call-${(calls += 1)}`;
      const at = (): string => new Date().toISOString();
      for (const listener of listeners) {
        listener({ type: 'tool_started', callId, tool: step.tool, input: params, at: at() });
      }
      const result = await tool.execute(params, undefined);
      for (const listener of listeners) {
        listener({
          type: 'tool_finished',
          callId,
          tool: step.tool,
          output: auditProjectionOf(result),
          isError: result.status !== 'ok',
          at: at(),
        });
      }
      this.results.set(step.label, {
        label: step.label,
        tool: step.tool,
        status: result.status,
        payload: JSON.parse(result.modelText) as Record<string, unknown>,
      });
    };
    const session: AgentSession = {
      id: 'extraction-session',
      logPath: `${options.runDir}/agent/extraction-session.jsonl`,
      authSource: 'managed',
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      steer: () => Promise.resolve('idle'),
      abort: () => Promise.resolve(),
      close: () => Promise.resolve(),
      run: async (): Promise<AgentRunResult> => {
        for (const step of SCRIPT) await call(step);
        return { outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } };
      },
    };
    return Promise.resolve(session);
  }
}

class SilentConnector implements AgentTaskConnector {
  public readonly interactive = false;
  public requestConfirmation(
    _request: ConfirmationRequest,
    _signal: AbortSignal,
  ): Promise<'granted'> {
    return Promise.resolve('granted');
  }
  public emitAgentEvent(_event: AgentProgressEvent): void {
    // Progress rendering is not what this contract asserts.
  }
  public renderAgentOutcome(): void {
    // The outcome is returned directly.
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

/** No page here needs a browser; any launch is a regression this run would show. */
function refusingBrowser(): BrowserProvider {
  return {
    launch: () => Promise.reject(new Error('no browser in this contract')),
    detectChrome: () => Promise.resolve(null),
  } as unknown as BrowserProvider;
}

function jsonl(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('@no-llm FEAT-051 integrated contract — shape-aware extraction with links', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-extraction-'));
    previousHome = process.env.YANTRA_HOME;
    process.env.YANTRA_HOME = join(root, 'home');
    resetPathCache();
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = previousHome;
    resetPathCache();
    await rm(root, { recursive: true, force: true });
  });

  it('reads the listing as records, follows offered links, and refuses a guess', async () => {
    const requests: string[] = [];
    const httpRequestFn = ((url: string) => {
      requests.push(String(url));
      const html = page(String(url));
      return Promise.resolve({
        statusCode: html === null ? 404 : 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: Readable.from([Buffer.from(html ?? 'not found', 'utf8')]),
      });
    }) as unknown as NonNullable<EnvironmentLeaves['httpRequestFn']>;
    const provider: SearchProvider = {
      name: 'duckduckgo',
      search: () =>
        Promise.resolve([
          {
            url: LISTING,
            title: 'Teyra for sale',
            snippet: 'New listings near you',
            source: 'duckduckgo',
            rank: 1,
            publishedAt: null,
          },
        ]),
    };
    let driver: ScriptedProvider | undefined;

    const outcome = await runAgenticTask(
      {
        goal: 'List dealer, price, and colors for new Teyra listings in Fairview',
        profile: COMMAND_TASK_PROFILES.research,
        model: { provider: 'fixture', id: 'fixture-model' },
        auth: { mode: 'managed' },
        connector: new SilentConnector(),
      },
      {
        runStore: new LocalRunStore(join(root, 'runs')),
        urlPolicyConfig: { maxUrlLength: 2048, requireHttps: false },
        environmentLeaves: {
          keychain: memoryKeychain(),
          ethicsConfig: defaultEthicsConfig,
          searchConfig: DEFAULT_SEARCH_CONFIG,
          blocklist: new BlocklistImpl(),
          createBrowserProvider: () => refusingBrowser(),
          httpRequestFn,
          resolveSearchProvider: (() =>
            Promise.resolve(ok(provider))) as unknown as EnvironmentLeaves['resolveSearchProvider'],
        },
        createProvider: (services) => {
          driver = new ScriptedProvider(services);
          return driver;
        },
      },
    );
    if (driver === undefined)
      throw new Error(`the run never created its provider: ${JSON.stringify(outcome)}`);
    const { results } = driver;

    expect(outcome.kind).toBe('published');
    // G3: every move in the trace was offered by an earlier result.
    expect(driver.unreachable).toEqual([]);

    // G2: the listing is a collection of 6 records carrying every card field.
    const listing = results.get('listing');
    expect(listing?.payload.shape).toBe('collection');
    const records = listing?.payload.records as {
      id: string;
      title: string;
      url: string;
      text: string[];
    }[];
    expect(records).toHaveLength(6);
    records.forEach((record, index) => {
      const text = JSON.stringify(record);
      expect(record.title).toBe(`New 2026 Teyra Summit ${index + 1}`);
      expect(record.url).toBe(`${ORIGIN}/vehicle/itm-0${index + 1}`);
      expect(text).toContain(String(50_000 + index * 250));
      expect(text).toContain(LISTING_SELLERS[index]);
      expect(text).toMatch(/\d+\.\d mi away/u);
    });

    // The facet and both details were followed and audited as discovered from the listing.
    const listingId = listing?.payload.source_id;
    expect(results.get('facet')?.status).toBe('ok');
    const toolCalls = jsonl(await readFile(join(outcome.runDir, 'tool-calls.jsonl'), 'utf8'));
    const provenances = toolCalls
      .map((line) => JSON.stringify(line))
      .filter((line) => line.includes('"kind":"discovered"'));
    expect(provenances).toHaveLength(3);
    for (const line of provenances) expect(line).toContain(`"via":"${String(listingId)}"`);

    // Both details are detail pages with the truth colors.
    for (const [label, id] of [
      ['detail-1', 'itm-01'],
      ['detail-2', 'itm-02'],
    ] as const) {
      const detail = results.get(label)?.payload;
      const fields = detail?.fields as Record<string, string>;
      expect(detail?.shape).toBe('detail');
      expect(fields['Exterior color']).toBe(COLORS[id]?.[0]);
      expect(fields['Interior color']).toBe(COLORS[id]?.[1]);
    }

    // TODO 208: the guessed URL is refused before any request.
    expect(results.get('guess')?.payload).toMatchObject({ error_code: 'URL_NOT_FROM_EVIDENCE' });
    expect(requests).not.toContain(UNATTESTED);
    // The listing was read once, by the search; the web_fetch was a store read.
    expect(requests.filter((url) => url === LISTING)).toHaveLength(1);
    expect(listing?.payload.from_store).toBe(true);

    // Run health tells the same story.
    const health = JSON.parse(await readFile(join(outcome.runDir, 'run-health.json'), 'utf8')) as {
      readonly extraction?: {
        readonly pages_by_shape: Record<string, number>;
        readonly discovered_follows: number;
      };
    };
    expect(health.extraction?.discovered_follows).toBe(3);
    expect(health.extraction?.pages_by_shape.collection ?? 0).toBeGreaterThanOrEqual(1);

    // Every audit line parsed above; every record ID the model saw resolves.
    expect(toolCalls.length).toBeGreaterThan(0);
    const ids = [...results.values()].flatMap((received) =>
      recordsOf(received).map((record) => record.id),
    );
    expect(ids.length).toBeGreaterThan(6);
    for (const id of ids) expect(driver.services.documents.resolveAnchor(id)).not.toBeNull();
  });
});
