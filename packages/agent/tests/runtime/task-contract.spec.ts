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
  NO_ACTION_TERMS,
  TaskContractStore,
  effectiveActionTermsOf,
  hostSatisfiesRequiredSource,
  normalizeContract,
  normalizeSourceHost,
  renderActionPhrase,
  renderContractEcho,
  requirementOrigins,
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

type ContractOverrides = Omit<Partial<TaskContractParams>, 'ranking'> & {
  ranking?: TaskContractParams['ranking'] | undefined;
};

function params(overrides: ContractOverrides = {}): TaskContractParams {
  const { ranking, ...rest } = {
    deliverable: 'table' as const,
    subject: 'new 2026 SUV listings',
    required_fields: ['dealer', 'price', 'exterior color', 'interior color'],
    filters: [
      { name: 'condition', value: 'new' },
      { name: 'drivetrain', value: 'AWD' },
    ],
    required_sources: ['example-listings.test'],
    ranking: { field: 'price', direction: 'asc' as const },
    limit: 10,
    ...overrides,
  };
  return { ...rest, ...(ranking === undefined ? {} : { ranking }) };
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
      fill: null,
      artifacts: [],
      effects: { submit: 'allowed' },
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
    ] satisfies ContractOverrides[]) {
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

describe('@no-llm contract action terms (FEAT-054)', () => {
  const actionParams = (overrides: Partial<TaskContractParams> = {}): TaskContractParams => ({
    deliverable: 'actions',
    subject: 'the sign-up form',
    required_sources: ['forms.example.test'],
    ...overrides,
  });

  it('normalizes fill, artifacts, and effects', () => {
    const result = normalizeContract(
      actionParams({
        fill: { coverage: 'listed', fields: ['  First\u0007 name ', 'Email'] },
        artifacts: [{ kind: 'screenshot', scope: 'viewport' }],
        effects: { submit: 'forbidden' },
      }),
      cleaning,
    );
    expect(result.isOk && result.value).toMatchObject({
      deliverable: 'actions',
      fill: { coverage: 'listed', fields: ['First name', 'Email'] },
      artifacts: [{ kind: 'screenshot', scope: 'viewport' }],
      effects: { submit: 'forbidden' },
    });
  });

  it('masks a listed field name that carries the user’s own input', () => {
    const vault = new UserInputVault();
    vault.redact('reply to jane.private@example.test');
    const token = vault.mask('jane.private@example.test');
    expect(token).not.toBe('jane.private@example.test');
    const result = normalizeContract(
      actionParams({ fill: { coverage: 'listed', fields: ['jane.private@example.test'] } }),
      { ...cleaning, mask: (text) => vault.mask(text) },
    );
    expect(result.isOk && result.value.fill?.fields).toEqual([token]);
  });

  it('defaults absent action terms to neutral values', () => {
    const result = normalizeContract(actionParams(), cleaning);
    expect(result.isOk && result.value).toMatchObject({
      fill: null,
      artifacts: [],
      effects: { submit: 'allowed' },
    });
  });

  it('rejects duplicate listed fields and duplicate artifacts with contract-duplicate', () => {
    expect(
      normalizeContract(
        actionParams({ fill: { coverage: 'listed', fields: ['Email', 'EMAIL'] } }),
        cleaning,
      ),
    ).toEqual({ isOk: false, error: { cause: 'contract-duplicate', name: 'EMAIL' } });
    expect(
      normalizeContract(
        actionParams({
          artifacts: [
            { kind: 'screenshot', scope: 'full_page' },
            { kind: 'screenshot', scope: 'full_page' },
          ],
        }),
        cleaning,
      ),
    ).toEqual({
      isOk: false,
      error: { cause: 'contract-duplicate', name: 'full-page screenshot' },
    });
  });

  it.each([
    ['listed with no fields', { coverage: 'listed' as const }, 'listed'],
    ['listed with an empty list', { coverage: 'listed' as const, fields: [] }, 'listed'],
    [
      'all_eligible with fields',
      { coverage: 'all_eligible' as const, fields: ['Email'] },
      'all_eligible',
    ],
  ])('rejects %s with contract-fill-fields', (_label, fill, coverage) => {
    expect(normalizeContract(actionParams({ fill }), cleaning)).toEqual({
      isOk: false,
      error: { cause: 'contract-fill-fields', coverage },
    });
  });

  it.each([
    ['an actions deliverable', { deliverable: 'actions' as const }],
    ['a fill', { deliverable: 'report' as const, fill: { coverage: 'all_eligible' as const } }],
    [
      'an artifact',
      {
        deliverable: 'report' as const,
        artifacts: [{ kind: 'screenshot' as const, scope: 'viewport' as const }],
      },
    ],
    [
      'a forbidden submit',
      { deliverable: 'report' as const, effects: { submit: 'forbidden' as const } },
    ],
  ])('rejects %s in research with contract-actions-command', (_label, overrides) => {
    expect(
      normalizeContract(actionParams(overrides), { ...cleaning, command: 'research' }),
    ).toEqual({ isOk: false, error: { cause: 'contract-actions-command' } });
  });

  it('accepts neutral action terms in research and action terms in do', () => {
    expect(
      normalizeContract(
        actionParams({
          deliverable: 'report',
          artifacts: [],
          effects: { submit: 'allowed' },
        }),
        { ...cleaning, command: 'research' },
      ).isOk,
    ).toBe(true);
    expect(
      normalizeContract(actionParams({ fill: { coverage: 'all_eligible' } }), {
        ...cleaning,
        command: 'do',
      }).isOk,
    ).toBe(true);
  });
});

describe('@no-llm effective action terms carry forward (FEAT-054 S2)', () => {
  const body = (overrides: Partial<TaskContractParams>): TaskContractBody => {
    const result = normalizeContract(
      { deliverable: 'actions', subject: 'the form', ...overrides },
      cleaning,
    );
    if (!result.isOk) throw new Error(`fixture rejected: ${result.error.cause}`);
    return result.value;
  };

  const storeDirs = new WeakMap<TaskContractStore, string>();
  const storeDir = (store: TaskContractStore): string => storeDirs.get(store) ?? '';

  async function storeWith(...bodies: TaskContractBody[]): Promise<TaskContractStore> {
    const dir = await runDir();
    const store = new TaskContractStore({
      runId: 'run-1',
      runDir: dir,
      command: 'do',
      required: true,
    });
    storeDirs.set(store, dir);
    for (const [index, value] of bodies.entries()) {
      await store.declare(value, `2026-10-15T12:00:0${index}.000Z`);
    }
    return store;
  }

  const full = (): TaskContractBody =>
    body({
      fill: { coverage: 'all_eligible' },
      artifacts: [{ kind: 'screenshot', scope: 'viewport' }],
      effects: { submit: 'forbidden' },
    });

  it('has neutral terms before any declaration', async () => {
    const store = await storeWith();
    expect(store.effectiveActionTerms()).toEqual(NO_ACTION_TERMS);
  });

  it('keeps every action item a later revision omits, each declared in revision 1', async () => {
    const store = await storeWith(full(), body({}));
    expect(store.effectiveActionTerms()).toEqual({
      fill: { coverage: 'all_eligible', fields: [], declaredIn: 1 },
      artifacts: [{ kind: 'screenshot', scope: 'viewport', declaredIn: 1 }],
      submit: { value: 'forbidden', declaredIn: 1 },
    });
  });

  it('does not let a later submit: allowed loosen an earlier forbidden', async () => {
    const store = await storeWith(full(), body({ effects: { submit: 'allowed' } }));
    expect(store.effectiveActionTerms().submit).toEqual({ value: 'forbidden', declaredIn: 1 });
  });

  it('adds a new artifact with the revision that requested it', async () => {
    const store = await storeWith(
      full(),
      body({ artifacts: [{ kind: 'screenshot', scope: 'full_page' }] }),
    );
    expect(store.effectiveActionTerms().artifacts).toEqual([
      { kind: 'screenshot', scope: 'viewport', declaredIn: 1 },
      { kind: 'screenshot', scope: 'full_page', declaredIn: 2 },
    ]);
  });

  it('keeps the first revision of an unchanged fill and takes a changed fill as new', async () => {
    const same = await storeWith(full(), full());
    expect(same.effectiveActionTerms().fill?.declaredIn).toBe(1);
    const changed = await storeWith(
      full(),
      body({ fill: { coverage: 'listed', fields: ['Email'] } }),
    );
    expect(changed.effectiveActionTerms().fill).toEqual({
      coverage: 'listed',
      fields: ['Email'],
      declaredIn: 2,
    });
  });

  it('writes the requirements in force into contract.json on every declaration', async () => {
    const store = await storeWith(
      full(),
      body({ artifacts: [{ kind: 'screenshot', scope: 'full_page' }] }),
    );
    const record = TaskContractRecord.parse(
      JSON.parse(await readFile(join(storeDir(store), 'contract.json'), 'utf8')),
    );
    expect(record.requirements).toEqual([
      { id: 'fill', declared_in: 1 },
      { id: 'artifact:screenshot:viewport', declared_in: 1 },
      { id: 'artifact:screenshot:full_page', declared_in: 2 },
      { id: 'effects.submit', declared_in: 1 },
    ]);
  });

  it('writes no requirements key for a contract without action items', async () => {
    const dir = await runDir();
    const store = new TaskContractStore({
      runId: 'run-1',
      runDir: dir,
      command: 'research',
      required: true,
    });
    await store.declare(normalized(), '2026-10-15T12:00:00.000Z');
    const raw = JSON.parse(await readFile(join(dir, 'contract.json'), 'utf8')) as object;
    expect('requirements' in raw).toBe(false);
  });

  it('reports the terms in force through each revision', async () => {
    const store = await storeWith(body({}), full());
    expect(store.effectiveActionTermsThrough(1)).toEqual(NO_ACTION_TERMS);
    expect(store.effectiveActionTermsThrough(2).submit.value).toBe('forbidden');
  });

  it('exposes requiredToPublish and the command', async () => {
    const dir = await runDir();
    const doStore = new TaskContractStore({
      runId: 'r',
      runDir: dir,
      command: 'do',
      required: true,
      requiredToPublish: true,
    });
    expect(doStore.requiredToPublish).toBe(true);
    expect(doStore.command).toBe('do');
    const research = new TaskContractStore({
      runId: 'r',
      runDir: dir,
      command: 'research',
      required: true,
    });
    expect(research.requiredToPublish).toBe(false);
  });

  it('derives the same terms from a pure revision list', () => {
    expect(
      effectiveActionTermsOf([
        { revision: 1, contract: full() },
        { revision: 2, contract: body({}) },
      ]).artifacts,
    ).toEqual([{ kind: 'screenshot', scope: 'viewport', declaredIn: 1 }]);
    expect(requirementOrigins(NO_ACTION_TERMS)).toEqual([]);
  });
});

describe('@no-llm action-term echo (FEAT-054)', () => {
  it('renders the action phrase in plain words', () => {
    const result = normalizeContract(
      {
        deliverable: 'actions',
        subject: 'the sign-up form',
        fill: { coverage: 'all_eligible' },
        artifacts: [{ kind: 'screenshot', scope: 'viewport' }],
        effects: { submit: 'forbidden' },
      },
      cleaning,
    );
    if (!result.isOk) throw new Error('fixture rejected');
    expect(renderContractEcho(result.value)).toBe(
      'actions of the sign-up form — fill all eligible fields; ' +
        'capture a viewport screenshot; do not submit',
    );
  });

  it('counts listed fields and joins several artifacts', () => {
    expect(
      renderActionPhrase({
        fill: { coverage: 'listed', fields: ['Email'], declaredIn: 1 },
        artifacts: [
          { kind: 'screenshot', scope: 'full_page', declaredIn: 1 },
          { kind: 'screenshot', scope: 'element', declaredIn: 2 },
        ],
        submit: { value: 'allowed', declaredIn: null },
      }),
    ).toBe('fill 1 listed field; capture a full-page screenshot and an element screenshot');
    expect(renderActionPhrase(NO_ACTION_TERMS)).toBeNull();
  });

  it('echoes carried-forward terms passed in, not only the current body', () => {
    const result = normalizeContract({ deliverable: 'actions', subject: 'the form' }, cleaning);
    if (!result.isOk) throw new Error('fixture rejected');
    expect(
      renderContractEcho(result.value, {
        ...NO_ACTION_TERMS,
        submit: { value: 'forbidden', declaredIn: 1 },
      }),
    ).toBe('actions of the form — do not submit');
  });

  it('collapses whitespace and stays within the bound with every term at maximum length', () => {
    const result = normalizeContract(
      {
        deliverable: 'actions',
        subject: 's'.repeat(200),
        required_sources: ['a.test', 'b.test', 'c.test', 'd.test', 'e.test'],
        notes: 'n   '.repeat(125),
        fill: {
          coverage: 'listed',
          fields: Array.from({ length: 40 }, (_, index) => `f${index}${'x'.repeat(55)}`),
        },
        artifacts: [
          { kind: 'screenshot', scope: 'viewport' },
          { kind: 'screenshot', scope: 'full_page' },
          { kind: 'screenshot', scope: 'element' },
        ],
        effects: { submit: 'forbidden' },
      },
      cleaning,
    );
    if (!result.isOk) throw new Error('fixture rejected');
    const echo = renderContractEcho(result.value);
    expect(echo.length).toBeLessThanOrEqual(CONTRACT_ECHO_MAX);
    expect(echo).not.toMatch(/\s{2}|[\r\n]/u);
    expect(echo).toContain('— fill 40 listed fields');
  });
});
