import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ToolAuditEntry } from '@yantra/protocol';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolCallWriter, type ToolAuditEntryInput } from '../../src/audit/tool-call-writer.js';

const here = dirname(fileURLToPath(import.meta.url));

function makeEntry(overrides: Partial<ToolAuditEntryInput> = {}): ToolAuditEntryInput {
  return {
    ts: '2026-07-14T12:00:00.000Z',
    run_id: 'run-1',
    session_id: 'session-1',
    call_id: 'call-1',
    tool: 'web_search',
    phase: 'start',
    input_sanitized: { query: 'safe' },
    output_sanitized: null,
    status: null,
    duration_ms: null,
    error_code: null,
    confirmation_id: null,
    ...overrides,
  };
}

async function readEntries(runDir: string): Promise<unknown[]> {
  const text = await readFile(join(runDir, 'tool-calls.jsonl'), 'utf8');
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

describe('@no-llm tool call projection writer', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-tool-calls-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('owns monotonic sequence order across interleaved completions', async () => {
    const writer = ToolCallWriter.forRun(runDir);
    await Promise.all([
      writer.append(makeEntry({ call_id: 'a' })),
      writer.append(makeEntry({ call_id: 'b' })),
      writer.append(
        makeEntry({
          call_id: 'b',
          phase: 'end',
          input_sanitized: null,
          output_sanitized: { result: 'b' },
          status: 'ok',
          duration_ms: 5,
        }),
      ),
      writer.append(
        makeEntry({
          call_id: 'a',
          phase: 'end',
          input_sanitized: null,
          output_sanitized: { result: 'a' },
          status: 'ok',
          duration_ms: 10,
        }),
      ),
    ]);
    await writer.close();
    await writer.close();

    const entries = (await readEntries(runDir)).map((entry) => ToolAuditEntry.parse(entry));
    expect(entries.map(({ seq }) => seq)).toEqual([0, 1, 2, 3]);
    expect(entries.map(({ call_id, phase }) => `${call_id}:${phase}`)).toEqual([
      'a:start',
      'b:start',
      'b:end',
      'a:end',
    ]);
  });

  it('leaves an aborted incomplete call as valid JSONL without inventing an end', async () => {
    const writer = ToolCallWriter.forRun(runDir);
    await writer.append(makeEntry({ call_id: 'unfinished' }));
    await writer.close();

    const entries = await readEntries(runDir);
    expect(entries).toHaveLength(1);
    expect(ToolAuditEntry.parse(entries[0])).toMatchObject({
      call_id: 'unfinished',
      phase: 'start',
    });
  });

  it('writes only the post-sanitizer payload supplied by the seam', async () => {
    const writer = ToolCallWriter.forRun(runDir);
    await writer.append(makeEntry({ input_sanitized: { apiKey: '[REDACTED]' } }));
    await writer.close();

    const text = await readFile(join(runDir, 'tool-calls.jsonl'), 'utf8');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('sk-test-raw-canary');
  });

  it('serializes every generated lifecycle sequence into schema-valid lines', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 30 }),
        async (endPhases) => {
          const propertyDir = await mkdtemp(join(tmpdir(), 'yantra-tool-property-'));
          try {
            const writer = ToolCallWriter.forRun(propertyDir);
            for (const [index, isEnd] of endPhases.entries()) {
              await writer.append(
                makeEntry({
                  call_id: `call-${index}`,
                  phase: isEnd ? 'end' : 'start',
                  input_sanitized: isEnd ? null : { index },
                  output_sanitized: isEnd ? { index } : null,
                  status: isEnd ? 'ok' : null,
                  duration_ms: isEnd ? index : null,
                }),
              );
            }
            await writer.close();
            for (const line of await readEntries(propertyDir)) {
              expect(ToolAuditEntry.safeParse(line).success).toBe(true);
            }
          } finally {
            await rm(propertyDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('keeps every completed line parseable when a child process is terminated mid-run', async () => {
    const helper = resolve(here, 'helpers', 'tool-call-writer-child.ts');
    const child = spawn(process.execPath, ['--import', 'tsx', helper, runDir], {
      cwd: resolve(here, '..', '..', '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolveReady, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Child writer did not become ready.')),
        8000,
      );
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('READY')) {
          clearTimeout(timeout);
          resolveReady();
        }
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== null && code !== 0) reject(new Error(`Child exited before ready: ${code}`));
      });
    });
    child.kill();
    await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));

    const entries = await readEntries(runDir);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(ToolAuditEntry.safeParse(entry).success).toBe(true);
    }
  }, 15_000);
});
