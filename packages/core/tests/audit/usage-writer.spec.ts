import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UsageLedger } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileUsageWriter } from '../../src/audit/usage-writer.js';

describe('@no-llm file usage writer agent aggregation', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-agent-usage-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('merges agent totals with existing call records', async () => {
    const writer = new FileUsageWriter(runDir);
    await writer.append({
      step_id: null,
      model: 'claude-sonnet',
      provider: 'anthropic',
      input_tokens: 2,
      output_tokens: 3,
      cost_estimate_usd: 0.01,
      latency_ms: 20,
      at: '2026-07-14T12:00:00.000Z',
    });
    await writer.mergeAgentUsage({
      turns: 2,
      input_tokens: 12,
      output_tokens: 7,
      cost_usd: 0.02,
    });
    await writer.close();

    const ledger = UsageLedger.parse(
      JSON.parse(await readFile(join(runDir, 'usage.json'), 'utf8')) as unknown,
    );
    expect(ledger.calls).toHaveLength(1);
    expect(ledger.agent).toEqual({
      turns: 2,
      input_tokens: 12,
      output_tokens: 7,
      cost_usd: 0.02,
    });
  });

  it('preserves nulls for provider metrics that are not reported', async () => {
    const writer = new FileUsageWriter(runDir);
    await writer.mergeAgentUsage({
      turns: 1,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
    });
    await writer.close();

    const ledger = UsageLedger.parse(
      JSON.parse(await readFile(join(runDir, 'usage.json'), 'utf8')) as unknown,
    );
    expect(ledger.agent).toMatchObject({
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
    });
  });
});
