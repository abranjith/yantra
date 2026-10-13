/**
 * Synthetic completed runs for the scorer's self-tests (FEAT-049 TASK-008).
 *
 * Each builder returns a {@link ScenarioRun} whose artifacts are shaped exactly
 * like a real run's — a Brief, `tool-calls.jsonl` audit records, run health,
 * usage — so the scorer is exercised through the same reads it performs on a
 * real run, with no Chrome and no model.
 */

import type { AgenticTaskOutcome } from '@yantra/agent';

import { truthRows, type TruthRow } from '../fixtures/inventory.js';
import type { RequestLogEntry } from '../fixtures/server.js';
import type { RunArtifacts, ScenarioRun } from '../runner.js';
import { listingTable } from '../scenarios/listing-table.js';
import type { SearchCallRecord } from '../search/scripted-provider.js';

import type { ScoreCard } from './scorecard-schema.js';

const RUN_ID = '20260925T130634Z-research-fixture';

/** A source entry as a Brief carries it. */
export interface SyntheticSource {
  readonly url: string;
  readonly excerpt?: string;
}

/** Build a Brief with numbered sources. */
export function brief(input: {
  readonly title: string;
  readonly overview: string;
  readonly findings?: readonly { readonly text: string; readonly citations?: readonly number[] }[];
  readonly comparison?: {
    readonly columns: readonly string[];
    readonly rows: readonly (readonly string[])[];
    readonly row_citations?: readonly (readonly number[])[];
  };
  readonly sections?: readonly {
    readonly heading: string;
    readonly body_md: string;
    readonly citations?: readonly number[];
    readonly kind?: string;
  }[];
  readonly sources?: readonly SyntheticSource[];
  readonly notices?: readonly {
    readonly kind: string;
    readonly source: string;
    readonly reason: string;
  }[];
  readonly constraints?: readonly {
    readonly name: string;
    readonly value: string;
    readonly status: string;
  }[];
}): Record<string, unknown> {
  return {
    title: input.title,
    overview: input.overview,
    key_findings: (input.findings ?? []).map((finding) => ({
      text: finding.text,
      citations: finding.citations ?? [],
      editorial: (finding.citations ?? []).length === 0,
      facet: null,
      children: [],
    })),
    sections: (input.sections ?? []).map((section) => ({ citations: [], ...section })),
    facets: input.comparison === undefined ? null : { comparison: input.comparison },
    sources: (input.sources ?? []).map((source, index) => ({
      n: index + 1,
      url: source.url,
      final_url: null,
      host: new URL(source.url).hostname,
      title: null,
      excerpt: source.excerpt ?? '',
    })),
    notices: input.notices ?? [],
    ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
  };
}

/** A `tool-calls.jsonl` end record for a successful `web_fetch` of `url` returning `text`. */
export function fetchAudit(url: string, text: string): Record<string, unknown> {
  return {
    run_id: RUN_ID,
    tool: 'web_fetch',
    phase: 'end',
    status: 'ok',
    error_code: null,
    output_sanitized: {
      content: [{ type: 'text', text: JSON.stringify({ url, title: null, text }) }],
      details: { bytes: text.length },
      status: 'ok',
    },
  };
}

/** A detail page's stored text, as today's extractor returns it. */
export function detailText(row: TruthRow): string {
  return [
    `$${row.fields.price}`,
    `Offered by ${row.fields.seller}, ${row.fields.distance} away.`,
    'Exterior color',
    row.fields.exteriorColor,
    'Interior color',
    row.fields.interiorColor,
    'Drivetrain',
    row.fields.drivetrain,
  ].join('\n\n');
}

/** Assemble a synthetic run from artifacts and harness logs. */
export function syntheticRun(input: {
  readonly brief?: unknown;
  readonly toolCalls?: readonly unknown[];
  readonly runHealth?: unknown;
  readonly usage?: unknown;
  readonly manifest?: unknown;
  readonly searchCalls?: readonly SearchCallRecord[];
  readonly requests?: readonly RequestLogEntry[];
  readonly browserLaunches?: number;
  readonly wallMs?: number;
  readonly outcome?: AgenticTaskOutcome['kind'];
}): ScenarioRun {
  const artifacts: RunArtifacts = {
    manifest: input.manifest ?? null,
    brief: input.brief ?? null,
    document: null,
    toolCalls: input.toolCalls === undefined ? null : { lines: input.toolCalls, unparseable: [] },
    events: null,
    runtime: null,
    usage: input.usage ?? null,
    report: null,
    runHealth: input.runHealth ?? null,
    contract: null,
    unparseableJson: [],
  };
  return {
    scenario: listingTable,
    mode: 'agentic',
    outcome: {
      kind: input.outcome ?? 'published',
      runId: RUN_ID,
      runDir: '',
    } as AgenticTaskOutcome,
    runDir: '',
    artifacts,
    toolResults: [],
    unreachable: [],
    skipped: [],
    registeredTools: [],
    prompt: null,
    progress: [],
    requests: input.requests ?? [],
    searchCalls: input.searchCalls ?? [],
    searchPeakConcurrency: 0,
    browserLaunches: input.browserLaunches ?? 0,
    rankSignals: [],
    egress: [],
    canaryHits: [],
    runtimeLogFindings: null,
    wallMs: input.wallMs ?? 0,
  };
}

/**
 * A scorecard with every run-to-run variable pinned (run ids, wall times, the
 * commit), so a scripted evaluation renders byte-identical Markdown.
 */
export function stableScorecard(card: ScoreCard): ScoreCard {
  let run = 0;
  return {
    ...card,
    git_sha: null,
    scenarios: card.scenarios.map((scenario) => ({
      ...scenario,
      aggregate: { ...scenario.aggregate, wall_ms: 0 },
      runs: scenario.runs.map((entry) => ({
        ...entry,
        run_id: `run-${(run += 1)}`,
        cost: { ...entry.cost, wall_ms: 0 },
      })),
    })),
    totals: { ...card.totals, wall_ms: 0 },
  };
}

/** `count` search calls with the given outcome, numbered from `first`. */
export function searchCalls(
  count: number,
  outcome: SearchCallRecord['outcome'],
  first = 1,
): SearchCallRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    call: first + index,
    query: 'norvale teyra',
    limit: 3,
    startedAt: index,
    endedAt: index + 1,
    outcome,
    peakConcurrency: 2,
  }));
}

/**
 * Run `20260925T130634Z`'s Brief, adapted to the fixtures: a price range, one
 * seller lifted from a snippet, six uncited findings, an "AWD" title, empty
 * notices, eleven failed searches in concurrent pairs, and an exhausted
 * navigation budget.
 */
export function motivatingRun(): ScenarioRun {
  const listing = 'http://faceted-listing.yantra.test/new/results';
  return syntheticRun({
    brief: brief({
      title: 'Norvale Teyra AWD offers near Fairview',
      overview:
        'Prices for this trim range from 49,415 to 51,040, and most listings cluster near 50,265. ' +
        'The listing site renders each listing’s dealer name and colors client-side.',
      findings: [
        { text: 'Lakeside Motors appears in a search snippet at 50,265.' },
        { text: 'Several listings show dealer fees included in the price.' },
        { text: 'Distances range from a few miles to over forty miles.' },
        { text: 'Colors were not visible on the results page.' },
        { text: 'Two sellers appear on more than one results page.' },
        { text: 'A used listing was also visible at a lower price.' },
      ],
      sources: [
        { url: listing },
        { url: 'http://structured-listing.yantra.test/results' },
        { url: 'http://article.yantra.test/guides/home-backup-battery-sizing' },
      ],
    }),
    toolCalls: [fetchAudit(listing, 'Prices 49,415 to 51,040')],
    searchCalls: [...searchCalls(11, 'challenge'), ...searchCalls(11, 'ok', 12)],
    runHealth: {
      budgets: { navigations_used: 30, navigations_limit: 30, exhausted: ['navigations'] },
    },
    usage: {
      calls: Array.from({ length: 15 }, () => ({
        input_tokens: 9_000,
        output_tokens: 400,
        cost_estimate_usd: 0.011,
      })),
    },
    browserLaunches: 48,
  });
}

/**
 * An oracle Brief for `listing-table`: the expected rows in a comparison
 * table, each cited to its detail page, every filter verified.
 */
export function oracleRun(): ScenarioRun {
  const rows = truthRows();
  const expected = ['itm-08', 'itm-03', 'itm-13', 'itm-01', 'itm-10'].map((id) => {
    const row = rows.find((candidate) => candidate.itemId === id);
    if (row === undefined) throw new Error(`no truth row ${id}`);
    return row;
  });
  return syntheticRun({
    brief: brief({
      title: 'New 2026 Norvale Teyra Summit AWD offers near Fairview',
      overview: 'Five AWD listings from faceted-listing.yantra.test, lowest price first.',
      comparison: {
        columns: ['Seller', 'Price', 'Exterior color', 'Interior color'],
        rows: expected.map((row) => [
          row.fields.seller,
          `$${row.fields.price}`,
          row.fields.exteriorColor,
          row.fields.interiorColor,
        ]),
        row_citations: expected.map((_, index) => [index + 1]),
      },
      sources: expected.map((row) => ({ url: row.detailUrl })),
      constraints: [
        { name: 'condition', value: 'new', status: 'verified' },
        { name: 'year', value: '2026', status: 'verified' },
        { name: 'trim', value: 'Summit', status: 'verified' },
        { name: 'drivetrain', value: 'AWD', status: 'verified' },
      ],
    }),
    toolCalls: expected.map((row) => fetchAudit(row.detailUrl, detailText(row))),
    runHealth: { budgets: { navigations_used: 7, navigations_limit: 30, exhausted: [] } },
    usage: {
      calls: Array.from({ length: 6 }, () => ({
        input_tokens: 5_000,
        output_tokens: 300,
        cost_estimate_usd: 0.006,
      })),
    },
    browserLaunches: 0,
  });
}
