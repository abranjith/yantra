/**
 * Brief and run-result fixtures for the web suites (FEAT-066). Every Brief is
 * parsed with the protocol schema, so a fixture can never drift from what a
 * run actually writes. Tests may import protocol runtime values; only `src/`
 * is restricted to type imports.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Brief, RunResultView, TemplatedReport } from '@yantra/protocol';

export const RUN_ID = '20261101T000000Z-research-a7b3c9d1';

export function source(n: number, overrides: Record<string, unknown> = {}) {
  return {
    n,
    url: `https://source-${String(n)}.example.com/page`,
    final_url: null,
    host: `source-${String(n)}.example.com`,
    title: `Source ${String(n)}`,
    excerpt: null,
    fetched_at: '2026-07-01T10:00:00.000Z',
    published_at: null,
    ...overrides,
  };
}

const METADATA = {
  search_provider: 'duckduckgo',
  synthesis: 'llm',
  deterministic_fallback_used: false,
  coverage: 0.8,
  freshness: null,
  citation_verdict: { claims_checked: 4, flagged: 1, stripped: 0 },
  usage: { input_tokens: 1200, output_tokens: 300, cost_usd: 0.04 },
  evidence: null,
  run_id: RUN_ID,
};

/** A valid Brief with `overrides` applied. */
export function brief(overrides: Record<string, unknown> = {}): Brief {
  return Brief.parse({
    brief_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    schema_version: '0.2',
    title: 'E-bike comparison',
    overview: 'The best value is the City 2 [1], cheaper than the Trail X [2].',
    key_findings: [
      {
        text: 'City 2 costs $1,299 [1]',
        citations: [1],
        editorial: false,
        facet: null,
        children: [],
      },
      {
        text: 'Trail X has the longest range [2]',
        citations: [2],
        editorial: false,
        facet: null,
        children: [],
      },
    ],
    sections: [],
    facets: null,
    sources: [source(1), source(2, { excerpt: 'The Trail X reaches 120 km on one charge.' })],
    metadata: METADATA,
    notices: [],
    ...overrides,
  });
}

/** Actions: a password fill (withheld), a click, a refused submit, a capture. */
export const ACTIONS = [
  {
    id: 'A1',
    kind: 'fill',
    label: 'Password',
    label_origin: 'explicit',
    section: 'Sign in',
    ref: 'e12',
    epoch: 3,
    call_id: 'call-7',
    host: 'shop.example',
    verification: { withheld: { reason: 'password', verdict: 'unchecked' } },
  },
  {
    id: 'A2',
    kind: 'fill',
    label: 'Email',
    label_origin: 'placeholder',
    confidence: 'medium',
    ref: 'e9',
    epoch: 3,
    call_id: 'call-6',
    host: 'shop.example',
    verification: { resolution: 'exact' },
  },
  {
    id: 'A3',
    kind: 'submit_refused',
    label: 'Place order',
    ref: 'e30',
    epoch: 4,
    call_id: 'call-9',
    host: 'shop.example',
    signal: 'structural',
  },
] as const;

/** The variants the spec names: actions, requirements, artifacts, constraints, consulted, alternatives. */
export function briefVariants(): Record<string, Brief> {
  return {
    basic: brief(),
    actions: brief({
      actions: ACTIONS,
      key_findings: [
        {
          text: 'Signed in [A1] and entered the email [A2]',
          citations: [],
          actions: ['A1', 'A2'],
          editorial: false,
          facet: null,
          children: [],
        },
        {
          text: 'The order was not placed [A3]',
          citations: [],
          actions: ['A3'],
          editorial: false,
          facet: null,
          children: [],
        },
      ],
      sources: [],
      overview: 'The form was filled [A1] [A2] and submission was refused [A3].',
    }),
    requirements: brief({
      requirements: [
        {
          id: 'deliverable',
          label: 'Save the confirmation',
          status: 'met',
          reason: null,
          declared_in: 1,
        },
        {
          id: 'fill',
          label: 'Fill every eligible field',
          status: 'unmet',
          reason: 'One field left empty.',
          declared_in: 1,
          exemptions: [{ label: 'Upload ID', reason: 'file_input' }],
          exempt_overflow: 2,
        },
      ],
    }),
    artifacts: brief({
      artifacts: [
        {
          kind: 'screenshot',
          scope: 'full_page',
          path: 'screenshots/capture-1-aaaaaaaaaaaa-p1.png',
          sha256: 'a'.repeat(64),
          bytes: 1000,
          width: 800,
          height: 600,
          part: 1,
          parts: 2,
          complete: false,
          labels: ['truncated'],
        },
        {
          kind: 'screenshot',
          scope: 'full_page',
          path: 'screenshots/capture-1-aaaaaaaaaaaa-p2.png',
          sha256: 'b'.repeat(64),
          bytes: 1000,
          width: 800,
          height: 600,
          part: 2,
          parts: 2,
          complete: false,
          labels: ['truncated'],
        },
      ],
    }),
    constraints: brief({
      constraints: [
        { name: 'price', value: 'under $1,500', status: 'verified', citations: [1] },
        { name: 'range', value: 'over 100 km', status: 'violated', citations: [2] },
      ],
    }),
    consulted: brief({
      sources: [
        source(1, { cited: true }),
        source(2, { cited: true }),
        source(3, { cited: false, title: 'Unused review' }),
      ],
    }),
    alternatives: brief({
      sections: [
        {
          kind: 'alternatives',
          heading: 'Other options',
          body_md: 'The Metro 1 [2] is close.',
          citations: [2],
        },
        { heading: 'Method', body_md: 'Compared listed prices [1].', citations: [1] },
      ],
      facets: {
        comparison: {
          columns: ['Model', 'Price'],
          rows: [
            ['City 2', '$1,299'],
            ['Trail X', '$1,899'],
          ],
          row_citations: [[1], [2]],
        },
      },
    }),
    mixedEditorial: brief({
      key_findings: [
        {
          text: 'City 2 costs $1,299 [1]',
          citations: [1],
          editorial: false,
          facet: null,
          children: [],
        },
        {
          text: 'Probably the better buy',
          citations: [],
          editorial: true,
          facet: null,
          children: [],
        },
      ],
    }),
    allEditorial: brief({
      key_findings: [
        {
          text: 'Probably the better buy',
          citations: [],
          editorial: true,
          facet: null,
          children: [],
        },
        { text: 'Worth a test ride', citations: [], editorial: true, facet: null, children: [] },
      ],
    }),
  };
}

/**
 * Every golden Brief the e2e harness expects, parsed. The goldens replace the
 * generated `brief_id` with a placeholder; a real run writes a ULID, so one
 * is restored before parsing.
 */
export function goldenBriefs(): Record<string, Brief> {
  const dir = join(import.meta.dirname, '..', '..', '..', '..', 'e2e', 'golden-briefs', 'expected');
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith('.brief.json'))
      .map((name) => {
        const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
        return [name, Brief.parse({ ...raw, brief_id: '01ARZ3NDEKTSV4RRFFQ69G5FAZ' })];
      }),
  );
}

/** A valid templated report. */
export function templatedReport(): TemplatedReport {
  return TemplatedReport.parse({
    report_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    schema_version: '0.2',
    template: { name: 'exec-brief', source: 'saved', path: null, hash: 'a'.repeat(64) },
    title: 'Weekly Report',
    slots: {},
    rendered_md: '# Weekly Report\n\nRevenue rose [1].\n\n- Churn fell [2].\n',
    sources: [source(1), source(2)],
    metadata: METADATA,
    notices: [{ source: 'search:duckduckgo', reason: '1 search failed', kind: 'search_failed' }],
  });
}

/** A valid run-result view with `overrides` applied. */
export function runView(overrides: Record<string, unknown> = {}): RunResultView {
  return RunResultView.parse({
    run_id: RUN_ID,
    mode: 'research',
    title: 'E-bike comparison',
    started_at: '2026-11-01T00:00:00.000Z',
    ended_at: '2026-11-01T00:01:00.000Z',
    duration_ms: 60_000,
    status: 'completed',
    task_outcome: 'fulfilled',
    termination_reason: 'model_finished',
    execution_state: null,
    live: null,
    document: { kind: 'brief', slot: { state: 'ok', path: 'brief.json', value: brief() } },
    outputs: null,
    terminal: null,
    run_health: { state: 'missing', path: 'run-health.json' },
    report: { exists: true, bytes: 120 },
    artifacts: [
      {
        path: 'brief.json',
        entry_id: 'brief.json',
        exposure: 'typed',
        viewer: 'brief',
        bytes: 2000,
        modified_at: '2026-11-01T00:01:00.000Z',
        over_inline_cap: false,
      },
      {
        path: 'brief.md',
        entry_id: 'brief.md',
        exposure: 'view',
        viewer: 'markdown',
        bytes: 900,
        modified_at: '2026-11-01T00:01:00.000Z',
        over_inline_cap: false,
      },
      {
        path: 'brief.html',
        entry_id: 'brief.html',
        exposure: 'download',
        viewer: 'none',
        bytes: 4000,
        modified_at: '2026-11-01T00:01:00.000Z',
        over_inline_cap: false,
      },
      {
        path: 'report.md',
        entry_id: 'report.md',
        exposure: 'view',
        viewer: 'markdown',
        bytes: 120,
        modified_at: '2026-11-01T00:01:00.000Z',
        over_inline_cap: false,
      },
    ],
    artifacts_truncated: false,
    notices_source: 'brief',
    ...overrides,
  });
}

/** A view of a Brief run. */
export function briefView(value: Brief, overrides: Record<string, unknown> = {}): RunResultView {
  return runView({
    title: value.title,
    document: { kind: 'brief', slot: { state: 'ok', path: 'brief.json', value } },
    ...overrides,
  });
}
