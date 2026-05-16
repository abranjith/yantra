import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FileAuditLogWriter } from '../../src/audit/log-writer.js';

describe('@no-llm audit log writer', () => {
  it('creates append-only JSONL files and writes parseable lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-audit-log-'));

    const writer = new FileAuditLogWriter();
    await writer.open(root);

    await writer.appendAgentCall({
      ts: '2026-05-11T14:22:03.118Z',
      task_id: 'task-1',
      step_id: 's1',
      direction: 'request',
      model: 'model',
      prompt_sanitized: 'text',
      response: null,
      latency_ms: null,
      cost_usd: null,
      sanitizer_profile: 'authenticated',
      transformations_applied: ['truncate'],
    });

    await writer.appendSecretResolution({
      ts: '2026-05-11T14:22:04.000Z',
      task_id: 'task-1',
      step_id: 's1',
      key: 'bank.password',
      outcome: 'resolved',
    });

    await writer.writeScopeSummary({
      public: 1,
      'read-only-data': 1,
      authenticated: 0,
      scope_violations_rejected: 0,
    });

    const agentLines = (await readFile(join(root, 'agent.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
    const secretsText = await readFile(join(root, 'secrets.jsonl'), 'utf8');

    expect(agentLines).toHaveLength(1);
    expect(() => JSON.parse(agentLines[0] ?? '')).not.toThrow();
    expect(secretsText.includes('"value"')).toBe(false);

    await writer.close();
    await rm(root, { recursive: true, force: true });
  });

  it('property: appended secrets JSONL is always parseable line-by-line', () => {
    return fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            ts: fc.constant('2026-05-11T14:22:04.000Z'),
            task_id: fc.string({ minLength: 1, maxLength: 12 }),
            step_id: fc.string({ minLength: 1, maxLength: 6 }),
            key: fc.string({ minLength: 3, maxLength: 20 }),
            outcome: fc.constantFrom<'resolved' | 'not_found' | 'error'>(
              'resolved',
              'not_found',
              'error',
            ),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (entries) => {
          const root = await mkdtemp(join(tmpdir(), 'yantra-audit-log-prop-'));
          const writer = new FileAuditLogWriter();
          await writer.open(root);

          for (const entry of entries) {
            await writer.appendSecretResolution(entry);
          }

          const lines = (await readFile(join(root, 'secrets.jsonl'), 'utf8'))
            .split(/\r?\n/)
            .filter((line) => line.trim().length > 0);

          for (const line of lines) {
            expect(() => JSON.parse(line)).not.toThrow();
            expect(line.includes('"value"')).toBe(false);
          }

          await writer.close();
          await rm(root, { recursive: true, force: true });
        },
      ),
      { numRuns: 40 },
    );
  });
});
