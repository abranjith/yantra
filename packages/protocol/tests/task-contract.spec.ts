import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { JSON_SCHEMA_ARTIFACTS } from '../src/emit/json-schema.js';
import {
  CONTRACT_REQUIREMENT_ID_PATTERN,
  TaskContractBody,
  TaskContractRecord,
  artifactRequirementId,
  emitJsonSchemas,
  type TaskContractBody as TaskContractBodyType,
  type TaskContractRecord as TaskContractRecordType,
} from '../src/index.js';

/**
 * A `contract.json` exactly as FEAT-052 wrote it, before the action terms
 * existed (the historical form-fill run, its host replaced by a synthetic one).
 */
const FEAT_052_CONTRACT_JSON = `{
  "schema_version": 1,
  "run_id": "20261014T023539Z-do-7039cbaa",
  "command": "do",
  "revisions": [
    {
      "revision": 1,
      "declared_at": "2026-10-14T02:35:46.886Z",
      "contract": {
        "deliverable": "report",
        "subject": "Filling test data into every field on the \\"filling test all fields\\" page",
        "required_fields": [],
        "filters": [],
        "required_sources": ["forms.example.test"],
        "ranking": null,
        "limit": null,
        "notes": "Goal: fill each field on the page with suitable test data, do not submit, then take a screenshot to verify."
      }
    }
  ]
}`;

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
    fill: null,
    artifacts: [],
    effects: { submit: 'allowed' },
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

describe('@no-llm TaskContractBody action terms (FEAT-054)', () => {
  const actions = (overrides: Partial<TaskContractBodyType> = {}): TaskContractBodyType =>
    body({
      deliverable: 'actions',
      required_fields: [],
      filters: [],
      ranking: null,
      limit: null,
      ...overrides,
    });

  it('parses a contract.json written before the action terms, with neutral defaults', () => {
    const parsed = TaskContractRecord.parse(JSON.parse(FEAT_052_CONTRACT_JSON));
    const contract = parsed.revisions[0]?.contract;
    expect(contract?.fill).toBeNull();
    expect(contract?.artifacts).toEqual([]);
    expect(contract?.effects).toEqual({ submit: 'allowed' });
    expect(parsed.requirements).toBeUndefined();
  });

  it('accepts an actions deliverable with no fields (the table-only rules do not fire)', () => {
    const value = actions({
      fill: { coverage: 'all_eligible' },
      artifacts: [{ kind: 'screenshot', scope: 'viewport' }],
      effects: { submit: 'forbidden' },
    });
    expect(TaskContractBody.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it('accepts a listed fill with fields', () => {
    const result = TaskContractBody.safeParse(
      actions({ fill: { coverage: 'listed', fields: ['First name', 'Email'] } }),
    );
    expect(result.success).toBe(true);
  });

  it.each([
    ['listed without fields', { coverage: 'listed' as const }],
    ['listed with an empty list', { coverage: 'listed' as const, fields: [] }],
    ['all_eligible with fields', { coverage: 'all_eligible' as const, fields: ['Email'] }],
    ['all_eligible with an empty list', { coverage: 'all_eligible' as const, fields: [] }],
    ['duplicate listed fields', { coverage: 'listed' as const, fields: ['Email', 'EMAIL'] }],
  ])('rejects %s at fill.fields', (_label, fill) => {
    const result = TaskContractBody.safeParse(actions({ fill }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(['fill', 'fields']);
  });

  it('bounds listed fields to 40 names of at most 60 characters', () => {
    const forty = Array.from({ length: 40 }, (_, index) => `field ${index}`);
    expect(
      TaskContractBody.safeParse(actions({ fill: { coverage: 'listed', fields: forty } })).success,
    ).toBe(true);
    expect(
      TaskContractBody.safeParse(
        actions({ fill: { coverage: 'listed', fields: [...forty, 'one more'] } }),
      ).success,
    ).toBe(false);
    expect(
      TaskContractBody.safeParse(
        actions({ fill: { coverage: 'listed', fields: ['x'.repeat(61)] } }),
      ).success,
    ).toBe(false);
  });

  it('rejects a duplicate artifact and more than three artifacts', () => {
    const duplicate = TaskContractBody.safeParse(
      actions({
        artifacts: [
          { kind: 'screenshot', scope: 'viewport' },
          { kind: 'screenshot', scope: 'viewport' },
        ],
      }),
    );
    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.issues[0]?.path).toEqual(['artifacts']);
    const four = TaskContractBody.safeParse(
      actions({
        artifacts: [
          { kind: 'screenshot', scope: 'viewport' },
          { kind: 'screenshot', scope: 'full_page' },
          { kind: 'screenshot', scope: 'element' },
          { kind: 'screenshot', scope: 'viewport' },
        ],
      }),
    );
    expect(four.success).toBe(false);
  });

  it('rejects an unknown scope, artifact kind, or submit value', () => {
    for (const bad of [
      { artifacts: [{ kind: 'screenshot', scope: 'window' }] },
      { artifacts: [{ kind: 'video', scope: 'viewport' }] },
      { effects: { submit: 'maybe' } },
    ]) {
      expect(TaskContractBody.safeParse({ ...actions(), ...bad }).success).toBe(false);
    }
  });
});

describe('@no-llm contract requirement ids and origins (FEAT-054)', () => {
  it('accepts every documented requirement id shape', () => {
    for (const id of [
      'deliverable',
      'fill',
      'effects.submit',
      artifactRequirementId('viewport'),
      artifactRequirementId('full_page'),
      artifactRequirementId('element'),
      'filter:condition',
      'filter:exterior color',
    ]) {
      expect({ id, ok: CONTRACT_REQUIREMENT_ID_PATTERN.test(id) }).toEqual({ id, ok: true });
    }
  });

  it('rejects unknown, empty, padded, and over-long ids', () => {
    for (const id of [
      '',
      'artifact:screenshot:window',
      'effects.navigate',
      'filter:',
      'filter: padded',
      `filter:${'x'.repeat(61)}`,
    ]) {
      expect({ id, ok: CONTRACT_REQUIREMENT_ID_PATTERN.test(id) }).toEqual({ id, ok: false });
    }
  });

  it('round-trips requirement origins on a record', () => {
    const value = record({
      command: 'do',
      revisions: [
        { revision: 1, declared_at: '2026-10-12T12:00:01.000Z', contract: body() },
        { revision: 2, declared_at: '2026-10-12T12:00:09.000Z', contract: body() },
      ],
      requirements: [
        { id: 'fill', declared_in: 1 },
        { id: 'artifact:screenshot:full_page', declared_in: 2 },
      ],
    });
    expect(TaskContractRecord.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it('rejects duplicate requirement ids and a declared_in past the last revision', () => {
    expect(
      TaskContractRecord.safeParse(
        record({
          requirements: [
            { id: 'fill', declared_in: 1 },
            { id: 'fill', declared_in: 1 },
          ],
        }),
      ).success,
    ).toBe(false);
    const late = TaskContractRecord.safeParse(
      record({ requirements: [{ id: 'fill', declared_in: 2 }] }),
    );
    expect(late.success).toBe(false);
    expect(late.error?.issues[0]?.path).toEqual(['requirements', 0, 'declared_in']);
  });
});
