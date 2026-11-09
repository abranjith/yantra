// @no-llm
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { RunEvent, type RunEventDelivery, type RunEventRecordType } from '@yantra/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { AskPipeline } from '../../src/extraction/ask-pipeline.js';
import type { ExecutionReceiptDraft } from '../../src/receipt/execution-receipt.js';
import { writeExecutionReceipt } from '../../src/receipt/execution-receipt.js';
import { readRunEvents } from '../../src/run-events/reader.js';
import { emitReceiptWritten, recordReceiptWritten } from '../../src/run-events/receipt-written.js';
import { RunEventStream } from '../../src/run-events/stream.js';
import { DeterministicSynthesizer } from '../../src/synthesis/deterministic.js';

import { AT, ManualScheduler, cleanupRunDirs, makeRunDir, silentLogger } from './support.js';

afterEach(cleanupRunDirs);

const draft: ExecutionReceiptDraft = {
  schema_version: 1,
  yantra_version: 'fixture',
  invoked_by: 'terminal',
  invocation_id: null,
  command: ['ask'],
  cwd: '/fixture',
  settings: [],
  content: [],
  browser: null,
};

function capture(): { stream: RunEventStream; seen: RunEventDelivery[] } {
  const stream = new RunEventStream();
  const seen: RunEventDelivery[] = [];
  stream.subscribe((d) => seen.push(d), { includeUncommitted: true });
  return { stream, seen };
}

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('@no-llm emitReceiptWritten', () => {
  it('emits a schema-valid receipt_written event', () => {
    const { stream, seen } = capture();
    const event = emitReceiptWritten(stream, { sha256: 'ab'.repeat(32), at: AT });

    expect(event).toEqual({
      kind: 'receipt_written',
      path: 'execution-receipt.json',
      sha256: 'ab'.repeat(32),
      at: AT,
    });
    expect(RunEvent.safeParse(event).success).toBe(true);
    expect(seen.map((d) => d.event)).toEqual([event]);
  });

  it.each([
    ['AB'.repeat(32), 'uppercase hex'],
    ['ab'.repeat(31), 'too short'],
    ['ab'.repeat(33), 'too long'],
    [`${'ab'.repeat(31)}zz`, 'non-hex'],
  ])('rejects digest %j (%s) before emitting anything', (digest) => {
    const { stream, seen } = capture();

    expect(() => emitReceiptWritten(stream, { sha256: digest })).toThrow(
      expect.objectContaining({ code: 'RUN_EVENT_INVALID' }),
    );
    expect(seen).toEqual([]);
  });

  it('accepts a resume receipt name and refuses anything else', () => {
    const { stream } = capture();

    expect(
      emitReceiptWritten(stream, {
        sha256: 'cd'.repeat(32),
        path: 'execution-receipt.resume-2.json',
      }).path,
    ).toBe('execution-receipt.resume-2.json');
    expect(() =>
      emitReceiptWritten(stream, { sha256: 'cd'.repeat(32), path: 'brief.json' }),
    ).toThrow(expect.objectContaining({ code: 'RUN_EVENT_INVALID' }));
  });

  it('records the digest of the receipt file bytes and its file name', async () => {
    const runDir = await makeRunDir();
    const first = await writeExecutionReceipt(runDir, draft);
    const resumed = await writeExecutionReceipt(runDir, draft, { resume: true });
    const { stream, seen } = capture();

    await recordReceiptWritten(stream, first.path);
    await recordReceiptWritten(stream, resumed.path);

    expect(seen.map((d) => d.event)).toEqual([
      expect.objectContaining({ path: 'execution-receipt.json', sha256: sha(first.path) }),
      expect.objectContaining({
        path: 'execution-receipt.resume-1.json',
        sha256: sha(resumed.path),
      }),
    ]);
  });
});

describe('@no-llm receipt_written in a real run', () => {
  it('an ask run records the receipt after it exists, with the digest of its bytes', async () => {
    const root = await makeRunDir();
    const pipeline = new AskPipeline({
      searchProvider: { name: 'duckduckgo', search: () => Promise.resolve([]) },
      fetcher: { fetch: () => Promise.reject(new Error('unused')) },
      extractor: { extract: () => Promise.reject(new Error('unused')) },
      cache: {
        get: () => Promise.resolve(null),
        put: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      },
      ethicsGate: { checkUrl: () => Promise.resolve({ ok: true as const }) },
      logger: silentLogger,
      runRootDir: root,
      synthesizer: new DeterministicSynthesizer({ clock: () => new Date(AT) }),
    });

    await pipeline.run({
      raw: 'q',
      normalized: 'q',
      limit: 3,
      noCache: true,
      noLlm: true,
      budgetCalls: null,
      searchProvider: null,
      perFetchTimeoutMs: 1000,
      pipelineBudgetMs: 10_000,
      length: 'medium',
      receipt: draft,
    });
    const [runId] = await readdir(root);
    const runDir = join(root, runId!);
    const records: RunEventRecordType[] = [];
    for await (const item of readRunEvents(join(runDir, 'run-events.jsonl'))) {
      if (item.status === 'event') records.push(item.record);
    }
    const receipt = records.filter((r) => r.event.kind === 'receipt_written');

    expect(receipt).toHaveLength(1);
    expect(receipt[0]?.event).toMatchObject({
      path: 'execution-receipt.json',
      sha256: sha(join(runDir, 'execution-receipt.json')),
    });
    // Recorded after task_started (the run exists) and before any phase event.
    const kinds = records.map((r) => r.event.kind);
    expect(kinds.indexOf('receipt_written')).toBeGreaterThan(kinds.indexOf('task_started'));
    expect(kinds.indexOf('receipt_written')).toBeLessThan(kinds.indexOf('search_completed'));
  });

  it('a pre-open receipt is committed once the log opens', async () => {
    const runDir = await makeRunDir();
    const written = await writeExecutionReceipt(runDir, draft);
    writeFileSync(join(runDir, 'marker'), '');
    const stream = new RunEventStream();

    await recordReceiptWritten(stream, written.path);
    stream.open({
      runDir,
      runId: 'run-1',
      sync: () => undefined,
      scheduler: new ManualScheduler(),
    });
    stream.close();
    const lines = readFileSync(join(runDir, 'run-events.jsonl'), 'utf8').trim().split('\n');

    expect(JSON.parse(lines[0]!)).toMatchObject({
      seq: 1,
      event: { kind: 'receipt_written', sha256: sha(written.path) },
    });
  });
});
