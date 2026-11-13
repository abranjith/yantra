// @no-llm
/**
 * The app's Run Health panel words every line exactly as `report.md` does
 * (FEAT-066 TASK-007): the web port is compared with the report builder's own
 * `## Run Health` section for the same `run-health.json`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunHealth } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The app's port (browser code may not import core).
import { runHealthLines } from '../../../../apps/web/src/features/run-result/run-health-lines.js';
import { MarkdownReportBuilder } from '../../src/audit/report-builder.js';

import { fixtureRunHealth } from './fixtures/build-run-dir.js';

let runDir: string;

beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'yantra-health-parity-'));
  await writeFile(
    join(runDir, 'manifest.json'),
    JSON.stringify({ runId: 'r', runKind: 'agentic' }),
  );
});

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

async function reportSection(health: unknown): Promise<string[]> {
  await writeFile(join(runDir, 'run-health.json'), JSON.stringify(health));
  const markdown = await new MarkdownReportBuilder().build(runDir, 'completed');
  const lines = markdown.split('\n');
  const start = lines.indexOf('## Run Health');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.indexOf('', start);
  return lines.slice(start + 1, end);
}

const BASE = fixtureRunHealth('r', 3);

describe('Run Health parity with report.md', () => {
  it.each([
    ['failures by code', BASE],
    [
      'no failures and no providers',
      {
        ...BASE,
        searches: { total: 0, ok: 0, failed_by_code: {}, providers: [] },
        fetches: {
          total: 0,
          by_mode: { http: 0, browser: 0 },
          repeat_fetches: 0,
          failed_by_code: {},
        },
        tool_failures: { total: 0, by_code: {} },
        budgets: { ...(BASE.budgets as object), exhausted: ['navigations', 'hosts'] },
      },
    ],
    [
      'tied counts and extraction',
      {
        ...BASE,
        searches: {
          total: 5,
          ok: 1,
          failed_by_code: { B_CODE: 2, A_CODE: 2 },
          providers: ['brave', 'duckduckgo'],
        },
        fetches: {
          total: 9,
          by_mode: { http: 6, browser: 3 },
          repeat_fetches: 2,
          failed_by_code: { FETCH_TIMEOUT: 1, FETCH_BLOCKED: 3 },
        },
        extraction: {
          pages_by_shape: { article: 2, collection: 1, table: 0 },
          records_shown: 14,
          links_offered: 8,
          links_withheld: 2,
          discovered_follows: 1,
        },
      },
    ],
  ])('%s', async (_label, health) => {
    const parsed = RunHealth.parse(health);
    expect(runHealthLines(parsed)).toEqual(await reportSection(health));
  });
});
