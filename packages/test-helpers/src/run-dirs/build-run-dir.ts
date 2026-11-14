/**
 * Run-directory builders for the run-view suites (FEAT-066) and the app
 * end-to-end suite (`@yantra/test-helpers/run-dirs`, Vitest-free).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The contents of one run directory. */
export interface RunDirSpec {
  readonly runId: string;
  /** An object is written as JSON; a string is written verbatim (e.g. corrupt); null writes none. */
  readonly manifest?: Readonly<Record<string, unknown>> | string | null;
  /** Run-relative paths (forward slashes) and their contents. */
  readonly files?: Readonly<Record<string, string | Buffer | Readonly<Record<string, unknown>>>>;
}

/** An ISO instant `seconds` after 2026-11-01T00:00:00Z. */
export function fixtureInstant(seconds: number): string {
  return new Date(Date.UTC(2026, 10, 1, 0, 0, 0) + seconds * 1000).toISOString();
}

/** A `formatRunId`-shaped id that starts at {@link fixtureInstant}(`seconds`). */
export function fixtureRunId(seconds: number, name = 'fixture', suffix = 'a7b3c9d1'): string {
  const compact = fixtureInstant(seconds)
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${compact}-${name}-${suffix}`;
}

/** A workflow `RunManifest` (the shape `LocalRunStore` writes). */
export function workflowManifest(
  runId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const startedAt =
    typeof overrides.startedAt === 'string' ? overrides.startedAt : fixtureInstant(0);
  return {
    runId,
    taskId: '01J00000000000000000000000',
    workflowName: 'fixture',
    workflowVersion: 1,
    status: 'completed',
    startedAt,
    endedAt: startedAt,
    durationMs: 1000,
    profileKind: 'ephemeral',
    cookieProfilePath: null,
    params: {},
    outputBindingNames: [],
    ...overrides,
  };
}

/** An agentic (`ask`/`research`/`do`) manifest in the workflow shape (`runKind: agentic`). */
export function agenticManifest(
  runId: string,
  mode: 'ask' | 'research' | 'do',
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return workflowManifest(runId, { workflowName: mode, runKind: 'agentic', ...overrides });
}

/** Writes one run directory under `runsDir` and returns its path. */
export async function buildRunDir(runsDir: string, spec: RunDirSpec): Promise<string> {
  const dir = join(runsDir, spec.runId);
  await mkdir(dir, { recursive: true });
  const manifest = spec.manifest === undefined ? workflowManifest(spec.runId) : spec.manifest;
  if (manifest !== null) {
    await writeFile(
      join(dir, 'manifest.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
    );
  }
  for (const [path, content] of Object.entries(spec.files ?? {})) {
    const target = join(dir, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      typeof content === 'string' || Buffer.isBuffer(content)
        ? content
        : JSON.stringify(content, null, 2),
    );
  }
  return dir;
}

/** JSON Lines text from records. */
export function jsonl(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

// ---------------------------------------------------------------------------
// Document factories (valid against the protocol schemas)
// ---------------------------------------------------------------------------

const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID_B = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

/** A Brief metadata block with nothing measured. */
export function fixtureMetadata(runId: string | null = null): Record<string, unknown> {
  return {
    search_provider: null,
    synthesis: 'deterministic',
    deterministic_fallback_used: false,
    coverage: null,
    freshness: null,
    citation_verdict: null,
    usage: null,
    evidence: null,
    run_id: runId,
  };
}

/** Numbered source `n`. */
export function fixtureSource(n: number, overrides: Record<string, unknown> = {}) {
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

/** A minimal valid Brief (schema 0.2) citing one source. */
export function fixtureBrief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brief_id: ULID_A,
    task_id: ULID_B,
    schema_version: '0.2',
    title: 'Fixture Brief',
    overview: 'Answer-first overview. [1]',
    key_findings: [
      { text: 'Finding one [1]', citations: [1], editorial: false, facet: null, children: [] },
    ],
    sections: [],
    facets: null,
    sources: [fixtureSource(1)],
    metadata: fixtureMetadata(),
    notices: [],
    ...overrides,
  };
}

/** A minimal valid templated report. */
export function fixtureTemplatedReport(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    report_id: ULID_A,
    task_id: ULID_B,
    schema_version: '0.2',
    template: { name: 'exec-brief', source: 'saved', path: null, hash: 'a'.repeat(64) },
    title: 'Weekly Report',
    slots: {},
    rendered_md: '# Weekly Report\n\nRevenue rose [1].\n',
    sources: [fixtureSource(1)],
    metadata: fixtureMetadata(),
    notices: [],
    ...overrides,
  };
}

/** A valid run-health.json. */
export function fixtureRunHealth(runId: string, notices = 0): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: runId,
    searches: {
      total: 3,
      ok: 2,
      failed_by_code: { SEARCH_NO_RESULTS: 1 },
      providers: ['duckduckgo'],
    },
    fetches: { total: 4, by_mode: { http: 3, browser: 1 }, repeat_fetches: 0, failed_by_code: {} },
    source_failures: { fetch: 0, extract: 0, blocked: 0, budget: 0, policy: 0 },
    browser: { launches: 1 },
    budgets: {
      navigations_used: 4,
      navigations_limit: 30,
      hosts_used: 2,
      hosts_limit: 20,
      exhausted: [],
    },
    tool_failures: { total: 1, by_code: { SEARCH_NO_RESULTS: 1 } },
    notices,
  };
}

// ---------------------------------------------------------------------------
// Scenario runs (FEAT-066 TASK-004/007 and the e2e suite)
// ---------------------------------------------------------------------------

/** An `ask` run with a valid Brief, run health and a report. */
export function askBriefRun(seconds: number): RunDirSpec {
  const runId = fixtureRunId(seconds, 'ask');
  return {
    runId,
    manifest: agenticManifest(runId, 'ask', {
      startedAt: fixtureInstant(seconds),
      endedAt: fixtureInstant(seconds + 4),
      durationMs: 4000,
      taskOutcome: 'fulfilled',
      terminationReason: 'model_finished',
    }),
    files: {
      'brief.json': fixtureBrief({ metadata: fixtureMetadata(runId) }),
      'brief.md': '# Fixture Brief\n',
      'brief.html': '<!doctype html><title>Fixture Brief</title>',
      'run-health.json': fixtureRunHealth(runId),
      'report.md': '# Report\n\nAll good.\n',
      'lease.json': '{"run_token":"NEVER-SERVED"}',
      'decisions/x.json': '{}',
    },
  };
}

/** A run that published a templated document. */
export function templatedRun(seconds: number): RunDirSpec {
  const runId = fixtureRunId(seconds, 'research');
  return {
    runId,
    manifest: agenticManifest(runId, 'research', {
      startedAt: fixtureInstant(seconds),
      taskOutcome: 'partial',
    }),
    files: {
      'document.json': fixtureTemplatedReport(),
      'document.md': '# Weekly Report\n',
      'report.md': '# Report\n',
    },
  };
}

/** A successful zero-synthesis workflow run: outputs, no document. */
export function workflowOutputsRun(seconds: number): RunDirSpec {
  const runId = fixtureRunId(seconds, 'bank-statement');
  return {
    runId,
    manifest: workflowManifest(runId, {
      workflowName: 'bank-statement',
      startedAt: fixtureInstant(seconds),
      taskOutcome: 'fulfilled',
    }),
    files: {
      'outputs.json': { balance: '1,024.00', statements: ['jan.pdf', 'feb.pdf'] },
      'events.jsonl': jsonl([
        { kind: 'task_started', ts: fixtureInstant(seconds) },
        { kind: 'task_completed', ts: fixtureInstant(seconds + 1), outputs_keys: ['balance'] },
      ]),
      'report.md': '# Report\n\nBalance read.\n',
    },
  };
}

/** A pre-Brief startup failure (`AGENT_AUTH_UNAVAILABLE`). */
export function startupFailureRun(seconds: number): RunDirSpec {
  const runId = fixtureRunId(seconds, 'research');
  return {
    runId,
    manifest: agenticManifest(runId, 'research', {
      startedAt: fixtureInstant(seconds),
      status: 'failed',
      taskOutcome: 'failed',
      agentError: {
        code: 'AGENT_AUTH_UNAVAILABLE',
        message: 'No credentials for anthropic. Run `yantra model auth`.',
        at: fixtureInstant(seconds + 1),
      },
    }),
    files: { 'report.md': '# Report\n\n## Failure (if any)\nFailure class: none\nCause: n/a\n' },
  };
}

/** An interrupted legacy run: owner lost, outcome failed, no run-events.jsonl. */
export function interruptedLegacyRun(seconds: number): RunDirSpec {
  const runId = fixtureRunId(seconds, 'research');
  return {
    runId,
    manifest: agenticManifest(runId, 'research', {
      startedAt: fixtureInstant(seconds),
      status: 'failed',
      taskOutcome: 'failed',
      terminationReason: 'owner_lost',
      executionState: 'interrupted',
    }),
    files: { 'report.md': '# Report\n\nThe run stopped.\n' },
  };
}

/** A legacy run with only manifest.json and report.md. */
export function legacyReportRun(seconds: number): RunDirSpec {
  const runId = fixtureRunId(seconds, 'fixture');
  return {
    runId,
    manifest: workflowManifest(runId, { startedAt: fixtureInstant(seconds) }),
    files: { 'report.md': '# Report\n\nLegacy run.\n' },
  };
}
