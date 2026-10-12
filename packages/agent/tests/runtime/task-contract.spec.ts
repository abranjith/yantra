import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DefaultSanitizer, UserInputVault } from '@yantra/core';
import { TaskContractRecord, type TaskContractBody } from '@yantra/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_ECHO_MAX,
  ContractRevisionLimitError,
  MISSING_CONTRACT_REASON,
  TaskContractStore,
  hostSatisfiesRequiredSource,
  normalizeContract,
  normalizeSourceHost,
  renderContractEcho,
  type TaskContractParams,
} from '../../src/runtime/task-contract.js';

const cleaning = { sanitizer: new DefaultSanitizer() };
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yantra-contract-'));
  dirs.push(dir);
  return dir;
}

function params(overrides: Partial<TaskContractParams> = {}): TaskContractParams {
  return {
    deliverable: 'table',
    subject: 'new 2026 SUV listings',
    required_fields: ['dealer', 'price', 'exterior color', 'interior color'],
    filters: [
      { name: 'condition', value: 'new' },
      { name: 'drivetrain', value: 'AWD' },
    ],
    required_sources: ['example-listings.test'],
    ranking: { field: 'price', direction: 'asc' },
    limit: 10,
    ...overrides,
  };
}

function normalized(overrides: Partial<TaskContractParams> = {}): TaskContractBody {
  const result = normalizeContract(params(overrides), cleaning);
  if (!result.isOk) throw new Error(`fixture contract rejected: ${result.error.cause}`);
  return result.value;
}

describe('@no-llm normalizeContract', () => {
  it('normalizes a full table contract', () => {
    expect(normalized()).toEqual({
      deliverable: 'table',
      subject: 'new 2026 SUV listings',
      required_fields: ['dealer', 'price', 'exterior color', 'interior color'],
      filters: [
        { name: 'condition', value: 'new' },
        { name: 'drivetrain', value: 'AWD' },
      ],
      required_sources: ['example-listings.test'],
      ranking: { field: 'price', direction: 'asc' },
      limit: 10,
      notes: null,
    });
  });

  it('normalizes a URL-shaped source to its bare hostname', () => {
    const body = normalized({ required_sources: ['https://www.Example-Listings.test/path?q=1'] });
    expect(body.required_sources).toEqual(['example-listings.test']);
  });

  it('rejects a site named without an address with contract-source-host', () => {
    const result = normalizeContract(params({ required_sources: ['Example Listings'] }), cleaning);
    expect(result).toEqual({
      isOk: false,
      error: { cause: 'contract-source-host', entry: 'Example Listings' },
    });
  });

  it('rejects case-insensitive duplicates with contract-duplicate', () => {
    for (const overrides of [
      { required_fields: ['Price', 'price'], ranking: undefined },
      {
        filters: [
          { name: 'Color', value: 'red' },
          { name: 'color', value: 'blue' },
        ],
      },
      { required_sources: ['a.test', 'https://www.A.test/x'] },
    ] satisfies Partial<TaskContractParams>[]) {
      const result = normalizeContract(params(overrides), cleaning);
      expect(result.isOk ? null : result.error.cause).toBe('contract-duplicate');
    }
  });

  it('rejects a table with no fields, but accepts an answer with none', () => {
    const table = normalizeContract(params({ required_fields: [], ranking: undefined }), cleaning);
    expect(table.isOk ? null : table.error).toEqual({ cause: 'contract-table-fields' });

    const answer = normalizeContract(
      { deliverable: 'answer', subject: 'the cheapest listing' },
      cleaning,
    );
    expect(answer.isOk).toBe(true);
    if (answer.isOk) {
      expect(answer.value).toMatchObject({
        required_fields: [],
        filters: [],
        required_sources: [],
        ranking: null,
        limit: null,
      });
    }
  });

  it('requires a table ranking to order by a listed field', () => {
    const result = normalizeContract(
      params({ ranking: { field: 'mileage', direction: 'asc' } }),
      cleaning,
    );
    expect(result.isOk ? null : result.error).toEqual({
      cause: 'contract-ranking-field',
      field: 'mileage',
    });
    expect(
      normalizeContract(params({ ranking: { field: 'PRICE', direction: 'desc' } }), cleaning).isOk,
    ).toBe(true);
  });

  it('reports only the first issue, in the documented order', () => {
    const result = normalizeContract(
      params({
        required_fields: [],
        required_sources: ['not a host'],
        ranking: { field: 'nope', direction: 'asc' },
      }),
      cleaning,
    );
    expect(result.isOk ? null : result.error.cause).toBe('contract-source-host');
  });

  it('redacts a secret in free text and strips control characters', () => {
    const canary = 'sk-CONTRACTcanaryABCDEFGHIJKLMN';
    const body = normalized({
      notes: `use key ${canary}\u001b[31m now`,
      subject: 'SUVs\u0007 listings\n',
    });
    expect(body.notes).not.toContain(canary);
    // eslint-disable-next-line no-control-regex -- asserting no control character survives.
    expect(JSON.stringify(body)).not.toMatch(/[\u0000-\u001F]/u);
    expect(body.subject).toBe('SUVs listings');
  });

  it('masks the user’s own input values back to placeholders before keeping them', () => {
    const email = 'jane.doe@example.com';
    const vault = new UserInputVault();
    vault.redact(`reply to ${email}`);
    const placeholder = vault.mask(email);
    expect(placeholder).not.toBe(email);

    const masked = normalizeContract(params({ notes: `send to ${email}` }), {
      ...cleaning,
      mask: (text) => vault.mask(text),
    });
    expect(masked.isOk).toBe(true);
    if (masked.isOk) {
      expect(masked.value.notes).not.toContain(email);
      expect(masked.value.notes).toContain(placeholder);
    }
  });

  it('treats empty optional lists like absent ones and maps notes to null', () => {
    const body = normalized({ filters: [], required_sources: [], notes: '   ' });
    expect(body.filters).toEqual([]);
    expect(body.required_sources).toEqual([]);
    expect(body.notes).toBeNull();
  });
});

describe('@no-llm normalizeSourceHost', () => {
  it.each([
    ['example.test', 'example.test'],
    ['WWW.Example.TEST', 'example.test'],
    ['https://www.example.test:8443/a/b', 'example.test'],
    ['http://shop.example.test.', 'shop.example.test'],
    ['example.test/path', 'example.test'],
  ])('normalizes %s', (raw, expected) => {
    expect(normalizeSourceHost(raw)).toBe(expected);
  });

  it.each([
    '',
    'example',
    'Example Listings',
    'ftp://example.test',
    'alice@example.test',
    'https://',
  ])('rejects %j', (raw) => {
    expect(normalizeSourceHost(raw)).toBeNull();
  });
});

describe('@no-llm hostSatisfiesRequiredSource', () => {
  const contract = normalized();

  it('accepts the host, its www. form, and its subdomains', () => {
    expect(hostSatisfiesRequiredSource('https://example-listings.test/a', contract)).toBe(true);
    expect(hostSatisfiesRequiredSource('https://www.example-listings.test/', contract)).toBe(true);
    expect(hostSatisfiesRequiredSource('https://cars.example-listings.test/x', contract)).toBe(
      true,
    );
  });

  it('rejects look-alike hosts and non-URLs', () => {
    expect(hostSatisfiesRequiredSource('https://example-listings.test.evil.test/', contract)).toBe(
      false,
    );
    expect(hostSatisfiesRequiredSource('https://notexample-listings.test/', contract)).toBe(false);
    expect(hostSatisfiesRequiredSource('not a url', contract)).toBe(false);
    expect(
      hostSatisfiesRequiredSource(
        'https://example-listings.test/',
        normalized({ required_sources: [] }),
      ),
    ).toBe(false);
  });
});

describe('@no-llm renderContractEcho', () => {
  it('renders every part in order on one line', () => {
    expect(renderContractEcho(normalized())).toBe(
      'table of new 2026 SUV listings — fields: dealer, price, exterior color, interior color; ' +
        'filters: condition=new, drivetrain=AWD; sources: example-listings.test; ' +
        'ranked by price ascending; top 10',
    );
  });

  it('omits empty parts', () => {
    const answer = normalizeContract(
      { deliverable: 'answer', subject: 'the lowest price' },
      cleaning,
    );
    if (!answer.isOk) throw new Error('fixture rejected');
    expect(renderContractEcho(answer.value)).toBe('answer of the lowest price');
  });

  it('bounds the echo with an ellipsis and keeps it to one line', () => {
    const body = normalized({ notes: 'n'.repeat(500), subject: 's'.repeat(200) });
    const echo = renderContractEcho(body);
    expect(echo.length).toBe(CONTRACT_ECHO_MAX);
    expect(echo.endsWith('…')).toBe(true);
    expect(echo).not.toMatch(/[\r\n]/u);
  });
});

describe('@no-llm TaskContractStore', () => {
  it('persists every declaration atomically and keeps current() equal to the last revision', async () => {
    const dir = await runDir();
    const store = new TaskContractStore({
      runId: 'run-1',
      runDir: dir,
      command: 'research',
      required: true,
    });
    expect(store.current()).toBeNull();

    expect(await store.declare(normalized(), '2026-10-12T12:00:00.000Z')).toEqual({ revision: 1 });
    const revised = normalized({ limit: 5 });
    expect(await store.declare(revised, '2026-10-12T12:00:05.000Z')).toEqual({ revision: 2 });

    const record = TaskContractRecord.parse(
      JSON.parse(await readFile(join(dir, 'contract.json'), 'utf8')),
    );
    expect(record.command).toBe('research');
    expect(record.revisions.map((entry) => entry.revision)).toEqual([1, 2]);
    expect(record.revisions.at(-1)?.contract).toEqual(store.current());
    expect(store.revisionCount()).toBe(2);
    expect(await readdir(dir)).toEqual(['contract.json']);
  });

  it('serializes parallel declarations', async () => {
    const dir = await runDir();
    const store = new TaskContractStore({
      runId: 'run-1',
      runDir: dir,
      command: 'do',
      required: true,
    });
    const results = await Promise.all([
      store.declare(normalized(), '2026-10-12T12:00:00.000Z'),
      store.declare(normalized({ limit: 3 }), '2026-10-12T12:00:00.000Z'),
    ]);
    expect(results.map((result) => result.revision).sort()).toEqual([1, 2]);
  });

  it('refuses a fourth declaration and leaves the file unchanged', async () => {
    const dir = await runDir();
    const store = new TaskContractStore({
      runId: 'run-1',
      runDir: dir,
      command: 'do',
      required: true,
    });
    for (let i = 0; i < 3; i += 1) await store.declare(normalized(), '2026-10-12T12:00:00.000Z');
    const before = await readFile(join(dir, 'contract.json'), 'utf8');

    await expect(store.declare(normalized(), '2026-10-12T12:00:00.000Z')).rejects.toBeInstanceOf(
      ContractRevisionLimitError,
    );
    expect(await readFile(join(dir, 'contract.json'), 'utf8')).toBe(before);
    expect(store.revisionCount()).toBe(3);
  });

  it('keeps nothing when the write fails, so the run still gets the notice', async () => {
    const store = new TaskContractStore({
      runId: 'run-1',
      runDir: join(tmpdir(), 'yantra-contract-missing-dir', 'nested'),
      command: 'research',
      required: true,
    });
    await expect(store.declare(normalized(), '2026-10-12T12:00:00.000Z')).rejects.toThrow();
    expect(store.current()).toBeNull();
    expect(store.notices()).toHaveLength(1);
  });

  it('gives exactly one notice only when required and undeclared', async () => {
    const dir = await runDir();
    const required = new TaskContractStore({
      runId: 'r',
      runDir: dir,
      command: 'research',
      required: true,
    });
    expect(required.notices()).toEqual([
      { kind: 'other', source: 'task-contract', reason: MISSING_CONTRACT_REASON },
    ]);
    await required.declare(normalized(), '2026-10-12T12:00:00.000Z');
    expect(required.notices()).toEqual([]);

    const ask = new TaskContractStore({ runId: 'r', runDir: dir, command: 'ask', required: false });
    expect(ask.notices()).toEqual([]);
    await expect(ask.declare(normalized(), '2026-10-12T12:00:00.000Z')).rejects.toThrow(/ask/u);
  });
});
