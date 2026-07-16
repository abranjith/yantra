import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MarkdownReportBuilder } from '../../src/audit/report-builder.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, '__fixtures__/sample-run');

describe('@no-llm report builder', () => {
  it('renders all required sections from run artifacts', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-builder-'));

    await copyFile(join(fixtureRoot, 'manifest.json'), join(runDir, 'manifest.json'));
    await copyFile(join(fixtureRoot, 'events.jsonl'), join(runDir, 'events.jsonl'));
    await copyFile(join(fixtureRoot, 'agent.jsonl'), join(runDir, 'agent.jsonl'));
    await copyFile(join(fixtureRoot, 'secrets.jsonl'), join(runDir, 'secrets.jsonl'));

    const builder = new MarkdownReportBuilder();
    const markdown = await builder.build(runDir, 'completed');

    expect(markdown).toContain('# Run');
    expect(markdown).toContain('## Steps Timeline');
    expect(markdown).toContain('## Failure (if any)');
    expect(markdown).toContain('## Locator Fallback');
    expect(markdown).toContain('## Sanitizer');
    expect(markdown).toContain('## Secrets Resolved');
    expect(markdown).toContain('## Audit Trail');

    const savedReport = await readFile(join(runDir, 'report.md'), 'utf8');
    expect(savedReport).toBe(markdown);

    await rm(runDir, { recursive: true, force: true });
  });

  it('includes explicit failure details when provided', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-builder-failure-'));

    await writeFile(join(runDir, 'events.jsonl'), '', 'utf8');
    await writeFile(join(runDir, 'agent.jsonl'), '', 'utf8');
    await writeFile(join(runDir, 'secrets.jsonl'), '', 'utf8');

    const builder = new MarkdownReportBuilder();
    const markdown = await builder.build(runDir, 'failed', {
      failureClass: 'scope_violation',
      message: 'Mutating step in read-only scope',
    });

    expect(markdown).toContain('Failure class: scope_violation');
    expect(markdown).toContain('Cause: Mutating step in read-only scope');

    await rm(runDir, { recursive: true, force: true });
  });

  it('renders agent usage totals including partial spend', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-builder-usage-'));
    await writeFile(join(runDir, 'events.jsonl'), '', 'utf8');
    await writeFile(join(runDir, 'agent.jsonl'), '', 'utf8');
    await writeFile(join(runDir, 'secrets.jsonl'), '', 'utf8');
    await writeFile(
      join(runDir, 'usage.json'),
      JSON.stringify({
        run_id: 'usage-run',
        calls: [],
        totals: {
          input_tokens: 0,
          output_tokens: 0,
          cost_estimate_usd: 0,
          call_count: 0,
        },
        agent: { turns: 2, input_tokens: 17, output_tokens: 7, cost_usd: 0.03 },
      }),
      'utf8',
    );

    const markdown = await new MarkdownReportBuilder().build(runDir, 'failed');
    expect(markdown).toContain('## Agent Usage');
    expect(markdown).toContain('Turns: 2');
    expect(markdown).toContain('Input tokens: 17');
    expect(markdown).toContain('Cost (USD): 0.03');

    await rm(runDir, { recursive: true, force: true });
  });
});
