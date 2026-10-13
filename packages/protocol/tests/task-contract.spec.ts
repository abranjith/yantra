import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { JSON_SCHEMA_ARTIFACTS } from '../src/emit/json-schema.js';
import {
  TaskContractBody,
  TaskContractRecord,
  emitJsonSchemas,
  type TaskContractBody as TaskContractBodyType,
  type TaskContractRecord as TaskContractRecordType,
} from '../src/index.js';

function body(overrides: Partial<TaskContractBodyType> = {}): TaskContractBodyType {
  return {
    deliverable: 'table',
    subject: 'new 2026 SUV listings',
    required_fields: ['dealer', 'price', 'exterior color'],
    filters: [{ name: 'drivetrain', value: 'AWD' }],
    required_sources: ['example-listings.test'],
    ranking: { field: 'price', direction: 'asc' },
    limit: 10,
    notes: null,
    ...overrides,
  };
}

function record(overrides: Partial<TaskContractRecordType> = {}): TaskContractRecordType {
  return {
    schema_version: 1,
    run_id: '20261012T120000Z-research-abcd1234',
    command: 'research',
    revisions: [{ revision: 1, declared_at: '2026-10-12T12:00:01.000Z', contract: body() }],
    ...overrides,
  };
}

describe('@no-llm TaskContractBody schema', () => {
  it('round-trips a populated table contract', () => {
    expect(TaskContractBody.parse(JSON.parse(JSON.stringify(body())))).toEqual(body());
  });

  it('accepts an answer contract with no fields, sources, ranking, or limit', () => {
    const answer = body({
      deliverable: 'answer',
      required_fields: [],
      filters: [],
      required_sources: [],
      ranking: null,
      limit: null,
    });
    expect(TaskContractBody.safeParse(answer).success).toBe(true);
  });

  it('rejects a table with no required fields', () => {
    const result = TaskContractBody.safeParse(body({ required_fields: [], ranking: null }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['required_fields']);
  });

  it('rejects case-insensitive duplicate fields and filter names, and duplicate sources', () => {
    expect(TaskContractBody.safeParse(body({ required_fields: ['Price', 'price'] })).success).toBe(
      false,
    );
    expect(
      TaskContractBody.safeParse(
        body({
          filters: [
            { name: 'Color', value: 'red' },
            { name: 'color', value: 'blue' },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      TaskContractBody.safeParse(body({ required_sources: ['a.test', 'a.test'] })).success,
    ).toBe(false);
  });

  it('requires a table ranking to order by a required field, case-insensitively', () => {
    expect(
      TaskContractBody.safeParse(body({ ranking: { field: 'mileage', direction: 'asc' } })).success,
    ).toBe(false);
    expect(
      TaskContractBody.safeParse(body({ ranking: { field: 'PRICE', direction: 'desc' } })).success,
    ).toBe(true);
    // An answer may be ranked by something it does not list as a field.
    expect(
      TaskContractBody.safeParse(
        body({ deliverable: 'answer', ranking: { field: 'mileage', direction: 'asc' } }),
      ).success,
    ).toBe(true);
  });

  it('accepts only normalized hostnames as sources', () => {
    for (const bad of [
      'https://example.test',
      'Example.test',
      'example',
      'example.test/path',
      'example.test:443',
    ]) {
      expect(TaskContractBody.safeParse(body({ required_sources: [bad] })).success).toBe(false);
    }
  });

  it('enforces the length and count bounds', () => {
    expect(TaskContractBody.safeParse(body({ subject: '' })).success).toBe(false);
    expect(TaskContractBody.safeParse(body({ subject: 'x'.repeat(201) })).success).toBe(false);
    expect(TaskContractBody.safeParse(body({ notes: 'x'.repeat(501) })).success).toBe(false);
    expect(TaskContractBody.safeParse(body({ limit: 0 })).success).toBe(false);
    expect(TaskContractBody.safeParse(body({ limit: 51 })).success).toBe(false);
    const thirteen = Array.from({ length: 13 }, (_, index) => `f${index}`);
    expect(
      TaskContractBody.safeParse(body({ required_fields: thirteen, ranking: null })).success,
    ).toBe(false);
    const six = Array.from({ length: 6 }, (_, index) => `s${index}.test`);
    expect(TaskContractBody.safeParse(body({ required_sources: six })).success).toBe(false);
  });
});

describe('@no-llm TaskContractRecord schema', () => {
  it('round-trips a record with revisions', () => {
    const value = record({
      command: 'do',
      revisions: [
        { revision: 1, declared_at: '2026-10-12T12:00:01.000Z', contract: body() },
        {
          revision: 2,
          declared_at: '2026-10-12T12:00:09.000Z',
          contract: body({ limit: 5 }),
        },
      ],
    });
    expect(TaskContractRecord.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it('rejects an empty or over-long revision list', () => {
    expect(TaskContractRecord.safeParse(record({ revisions: [] })).success).toBe(false);
    const four = [1, 2, 3, 4].map((revision) => ({
      revision,
      declared_at: '2026-10-12T12:00:01.000Z',
      contract: body(),
    }));
    expect(TaskContractRecord.safeParse(record({ revisions: four })).success).toBe(false);
  });

  it('rejects out-of-order revision numbers and an ask command', () => {
    const skipped = record({
      revisions: [{ revision: 2, declared_at: '2026-10-12T12:00:01.000Z', contract: body() }],
    });
    expect(TaskContractRecord.safeParse(skipped).success).toBe(false);
    expect(TaskContractRecord.safeParse({ ...record(), command: 'ask' }).success).toBe(false);
  });

  it('is emitted as task-contract.json', async () => {
    expect(JSON_SCHEMA_ARTIFACTS['task-contract.json']?.name).toBe('TaskContractRecord');
    const dir = await mkdtemp(path.join(tmpdir(), 'yantra-contract-schema-'));
    try {
      await emitJsonSchemas(dir);
      const emitted = JSON.parse(
        await readFile(path.join(dir, 'task-contract.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(JSON.stringify(emitted)).toContain('required_sources');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
