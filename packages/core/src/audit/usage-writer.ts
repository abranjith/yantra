import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { UsageCall, UsageLedger } from '@yantra/protocol';

import type { UsageWriter } from '../executor/types.js';

const FLUSH_DEBOUNCE_MS = 500;

/**
 * Appends `UsageCall` records to the run's `usage.json` file.
 *
 * Uses debounced batch writes to avoid hammering the filesystem on
 * high-frequency LLM calls. Call `close()` on run completion to flush any
 * remaining buffered records.
 */
export class FileUsageWriter implements UsageWriter {
  private readonly calls: UsageCall[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly runDir: string) {}

  append(call: UsageCall): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.calls.push(call);
    this.scheduleFlush();
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    if (typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
  }

  private async flush(): Promise<void> {
    if (this.calls.length === 0) return;

    const path = join(this.runDir, 'usage.json');
    await mkdir(this.runDir, { recursive: true });

    const totals = computeTotals(this.calls);
    const ledger: UsageLedger = {
      run_id: extractRunId(this.runDir),
      calls: [...this.calls],
      totals,
    };

    await writeFile(path, JSON.stringify(ledger, null, 2), 'utf8');
  }
}

function computeTotals(calls: UsageCall[]): UsageLedger['totals'] {
  const input_tokens = calls.reduce((sum, c) => sum + c.input_tokens, 0);
  const output_tokens = calls.reduce((sum, c) => sum + c.output_tokens, 0);
  const call_count = calls.length;

  const costValues = calls.map((c) => c.cost_estimate_usd).filter((v): v is number => v !== null);
  const cost_estimate_usd =
    costValues.length === calls.length ? costValues.reduce((sum, v) => sum + v, 0) : null;

  return { input_tokens, output_tokens, cost_estimate_usd, call_count };
}

function extractRunId(runDir: string): string {
  return runDir.split('/').pop() ?? runDir.split('\\').pop() ?? runDir;
}
