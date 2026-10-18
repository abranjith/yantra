import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskContractRecord } from '@yantra/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { taskContractSpec } from '../../../../src/adapters/pi/tools/task-contract.js';
import { BudgetTracker, DEFAULT_BUDGET_LIMITS } from '../../../../src/runtime/budget.js';
import { wrapTool, type WrappedTool } from '../../../../src/runtime/middleware.js';
import type { RunServices } from '../../../../src/runtime/run-services.js';
import { TaskContractStore } from '../../../../src/runtime/task-contract.js';

import { buildServices, recordingRuntimeLogger } from './test-support.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const VALID = {
  deliverable: 'table',
  subject: 'new SUV listings with a secret subject',
  required_fields: ['dealer', 'price', 'exterior color'],
  filters: [{ name: 'drivetrain', value: 'AWD' }],
  required_sources: ['https://www.Faceted-Listing.yantra.test/cars'],
  ranking: { field: 'price', direction: 'asc' },
  limit: 10,
  notes: 'listing pages only',
} as const;

async function setup(
  options: {
    readonly command?: 'research' | 'do';
    readonly overrides?: Omit<Parameters<typeof buildServices>[0] & object, 'contract'>;
  } = {},
): Promise<{
  readonly services: RunServices;
  readonly tool: WrappedTool;
  readonly dir: string;
  readonly logger: ReturnType<typeof recordingRuntimeLogger>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'yantra-contract-tool-'));
  dirs.push(dir);
  const logger = recordingRuntimeLogger();
  const services = buildServices({
    runDir: dir,
    runtimeLogger: logger,
    ...options.overrides,
    contract: new TaskContractStore({
      runId: 'run-1',
      runDir: dir,
      command: options.command ?? 'research',
      required: true,
    }),
  });
  return { services, tool: wrapTool(taskContractSpec(services), services), dir, logger };
}

async function readRecord(dir: string): Promise<TaskContractRecord> {
  return TaskContractRecord.parse(JSON.parse(await readFile(join(dir, 'contract.json'), 'utf8')));
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe('@no-llm task_contract tool', () => {
  it('records a valid contract, persists contract.json, and echoes the normalized form', async () => {
    const { services, tool, dir } = await setup();

    const result = await tool.execute(VALID, undefined);

    expect(result.status).toBe('ok');
    const payload = JSON.parse(result.modelText) as {
      revision: number;
      contract: { required_sources: string[] };
      note: string;
    };
    expect(payload.revision).toBe(1);
    expect(payload.contract.required_sources).toEqual(['faceted-listing.yantra.test']);
    expect(payload.note).toMatch(/call task_contract again with the full contract/u);
    const record = await readRecord(dir);
    expect(record.revisions.at(-1)?.contract).toEqual(services.contract.current());
    expect(record.revisions.at(-1)?.contract).toEqual(payload.contract);
    expect(result.details).toEqual({
      revision: 1,
      field_count: 3,
      filter_count: 1,
      source_hosts: ['faceted-listing.yantra.test'],
    });
  });

  it('appends a second revision on a second call', async () => {
    const { tool, dir } = await setup();
    await tool.execute(VALID, undefined);
    const second = await tool.execute({ ...VALID, limit: 5 }, undefined);

    expect(second.status).toBe('ok');
    const record = await readRecord(dir);
    expect(record.revisions.map((entry) => entry.revision)).toEqual([1, 2]);
    expect(record.revisions[1]?.contract.limit).toBe(5);
  });

  it('refuses a fourth declaration with CONTRACT_REVISION_LIMIT and leaves the file unchanged', async () => {
    const { tool, dir } = await setup();
    for (let i = 0; i < 3; i += 1) await tool.execute(VALID, undefined);
    const before = await readFile(join(dir, 'contract.json'), 'utf8');

    const result = await tool.execute(VALID, undefined);

    expect(result.status).toBe('error');
    expect(result.error_code).toBe('CONTRACT_REVISION_LIMIT');
    expect(result.retryable).toBe(false);
    expect(result.modelText).toMatch(/fixed at revision 3/u);
    expect(await readFile(join(dir, 'contract.json'), 'utf8')).toBe(before);
  });

  it('refuses a declaration after publish with ACTION_PHASE_CLOSED', async () => {
    const { services, tool, dir } = await setup();
    services.actionPhase.close();

    const result = await tool.execute(VALID, undefined);

    expect(result.error_code).toBe('ACTION_PHASE_CLOSED');
    expect(result.modelText).toMatch(/already been published/u);
    expect(await exists(join(dir, 'contract.json'))).toBe(false);
  });

  it.each([
    [{ ...VALID, required_sources: ['Example Listings'] }, /not a site address/u],
    [{ ...VALID, required_fields: ['Price', 'price'] }, /appears twice/u],
    [{ ...VALID, required_fields: [], ranking: undefined }, /table contract needs the fields/u],
    [{ ...VALID, ranking: { field: 'mileage', direction: 'asc' } }, /not one of required_fields/u],
  ])(
    'refuses an invalid contract with a cause-specific INVALID_INPUT and writes nothing',
    async (input, message) => {
      const { services, tool, dir } = await setup();

      const result = await tool.execute(input, undefined);

      expect(result.status).toBe('error');
      expect(result.error_code).toBe('INVALID_INPUT');
      expect(result.retryable).toBe(true);
      expect(result.modelText).toMatch(message);
      expect(await exists(join(dir, 'contract.json'))).toBe(false);
      expect(services.contract.current()).toBeNull();
    },
  );

  it('rejects a deliverable outside the closed set before running', async () => {
    const { tool, dir } = await setup();
    const result = await tool.execute({ ...VALID, deliverable: 'list' }, undefined);
    expect(result.error_code).toBe('INVALID_INPUT');
    expect(await exists(join(dir, 'contract.json'))).toBe(false);
  });

  it('logs one contract_declared line with counts and hostnames only', async () => {
    const { tool, logger } = await setup();
    await tool.execute(VALID, undefined);

    const lines = logger.lines.filter((line) => line.event === 'contract_declared');
    expect(lines).toEqual([
      {
        level: 'info',
        schema_version: 1,
        event: 'contract_declared',
        revision: 1,
        deliverable: 'table',
        field_count: 3,
        filter_count: 1,
        source_hosts: ['faceted-listing.yantra.test'],
        fill_coverage: null,
        artifact_count: 0,
        submit: 'allowed',
      },
    ]);
    const serialized = JSON.stringify(logger.lines);
    for (const text of ['secret subject', 'dealer', 'drivetrain', 'AWD', 'listing pages only']) {
      expect(serialized).not.toContain(text);
    }
  });

  it('never attests a required source as navigable', async () => {
    const { services, tool } = await setup();
    await tool.execute(VALID, undefined);
    expect(services.urlProvenance.has('https://faceted-listing.yantra.test/')).toBe(false);
  });
});

describe('@no-llm task_contract action terms (FEAT-054)', () => {
  const ACTIONS = {
    deliverable: 'actions',
    subject: 'the sign-up form',
    required_sources: ['forms.example.test'],
    fill: { coverage: 'all_eligible' },
    artifacts: [{ kind: 'screenshot', scope: 'viewport' }],
    effects: { submit: 'forbidden' },
  } as const;

  const AVAILABLE = {
    visionAssist: { available: false, reasons: ['grant_missing' as const] },
    deliverable: { available: true, reasons: [] },
  };
  const SUPPRESSED = {
    visionAssist: { available: false, reasons: ['suppressed_by_flag' as const] },
    deliverable: { available: false, reasons: ['suppressed_by_flag' as const] },
  };

  it('records action terms in do and logs counts only', async () => {
    const { tool, dir, logger } = await setup({ command: 'do' });

    const result = await tool.execute(ACTIONS, undefined);

    expect(result.status).toBe('ok');
    const record = await readRecord(dir);
    expect(record.revisions[0]?.contract).toMatchObject({
      deliverable: 'actions',
      fill: { coverage: 'all_eligible' },
      artifacts: [{ kind: 'screenshot', scope: 'viewport' }],
      effects: { submit: 'forbidden' },
    });
    expect(record.requirements).toEqual([
      { id: 'fill', declared_in: 1 },
      { id: 'artifact:screenshot:viewport', declared_in: 1 },
      { id: 'effects.submit', declared_in: 1 },
    ]);
    const line = logger.lines.find((entry) => entry.event === 'contract_declared');
    expect(line).toMatchObject({
      fill_coverage: 'all_eligible',
      artifact_count: 1,
      submit: 'forbidden',
    });
    expect(JSON.stringify(logger.lines)).not.toContain('sign-up form');
  });

  it('discloses a suppressed screenshot as a capability gap at declaration (FEAT-058)', async () => {
    const { tool } = await setup({ command: 'do', overrides: { capture: SUPPRESSED } });

    const result = await tool.execute(ACTIONS, undefined);

    const payload = JSON.parse(result.modelText) as { capability_gaps?: unknown };
    expect(payload.capability_gaps).toEqual([
      { item: 'artifact:screenshot:viewport', reason: 'suppressed_by_flag' },
    ]);
    expect((result.details as { capability_gaps?: unknown }).capability_gaps).toEqual(
      payload.capability_gaps,
    );
  });

  it('discloses no_browser for a run without a browser', async () => {
    const { tool } = await setup({ command: 'do' });

    const result = await tool.execute(ACTIONS, undefined);

    expect((JSON.parse(result.modelText) as { capability_gaps?: unknown }).capability_gaps).toEqual(
      [{ item: 'artifact:screenshot:viewport', reason: 'no_browser' }],
    );
  });

  it('reports no gap for every scope, full_page included, when deliverable capture is available', async () => {
    const { tool } = await setup({ command: 'do', overrides: { capture: AVAILABLE } });

    const result = await tool.execute(
      {
        ...ACTIONS,
        artifacts: [
          { kind: 'screenshot', scope: 'viewport' },
          { kind: 'screenshot', scope: 'full_page' },
          { kind: 'screenshot', scope: 'element' },
        ],
      },
      undefined,
    );

    expect('capability_gaps' in (JSON.parse(result.modelText) as object)).toBe(false);
  });

  it('ignores Vision Assist: unavailable vision with deliverable available has no gap', async () => {
    const { tool } = await setup({
      command: 'do',
      overrides: {
        capture: {
          visionAssist: {
            available: false,
            reasons: ['grant_missing', 'model_no_image_input'],
          },
          deliverable: { available: true, reasons: [] },
        },
      },
    });

    const result = await tool.execute(ACTIONS, undefined);

    expect('capability_gaps' in (JSON.parse(result.modelText) as object)).toBe(false);
  });

  it('omits capability_gaps when no artifact is declared', async () => {
    const { tool } = await setup({ command: 'do' });

    const result = await tool.execute(
      { deliverable: 'actions', subject: 'the form', effects: { submit: 'forbidden' } },
      undefined,
    );

    expect(result.status).toBe('ok');
    expect('capability_gaps' in (JSON.parse(result.modelText) as object)).toBe(false);
    expect('capability_gaps' in (result.details as object)).toBe(false);
  });

  it('uses an injected capability resolver over the deliverable default', async () => {
    const { tool } = await setup({
      command: 'do',
      overrides: { contractCapabilities: { captureGap: () => null } },
    });

    const result = await tool.execute(ACTIONS, undefined);

    expect('capability_gaps' in (JSON.parse(result.modelText) as object)).toBe(false);
  });

  it.each([
    [{ ...VALID, fill: { coverage: 'all_eligible' } }, /research cannot fill forms/u],
    [{ ...VALID, deliverable: 'actions' }, /research cannot fill forms/u],
  ])('refuses action terms in research with contract-actions-command', async (input, message) => {
    const { tool, dir } = await setup({ command: 'research' });

    const result = await tool.execute(input, undefined);

    expect(result.error_code).toBe('INVALID_INPUT');
    expect(result.modelText).toMatch(message);
    expect(await exists(join(dir, 'contract.json'))).toBe(false);
  });

  it.each([
    [{ coverage: 'listed' }, /needs the field names/u],
    [{ coverage: 'all_eligible', fields: ['Email'] }, /takes no fill.fields/u],
  ])('refuses an inconsistent fill with contract-fill-fields', async (fill, message) => {
    const { tool } = await setup({ command: 'do' });

    const result = await tool.execute({ ...ACTIONS, fill }, undefined);

    expect(result.error_code).toBe('INVALID_INPUT');
    expect(result.modelText).toMatch(message);
  });

  it('stays callable after the soft wall-clock boundary but not after the hard one', async () => {
    const soft = await setup({
      command: 'do',
      overrides: { limits: { softWallClockFraction: 0 } },
    });
    const declared = await soft.tool.execute(ACTIONS, undefined);
    expect(declared.status).toBe('ok');
    expect(soft.services.budgets.softWindDownReached).toBe(true);

    const hard = await setup({
      command: 'do',
      overrides: { limits: { wallClockMs: 0 } },
    });
    const refused = await hard.tool.execute(ACTIONS, undefined);
    expect(refused.error_code).toBe('BUDGET_EXHAUSTED');
    expect(await exists(join(hard.dir, 'contract.json'))).toBe(false);
  });
});

it.each([900000, Infinity])(
  'FEAT-059 reports exploration and publication seconds for %s ms',
  async (wallClockMs) => {
    const { services: base } = await setup();
    const services = {
      ...base,
      budgets: new BudgetTracker({ ...DEFAULT_BUDGET_LIMITS, wallClockMs }, () => 0),
    };
    const result = await wrapTool(taskContractSpec(services), services).execute(VALID, undefined);
    const model = JSON.parse(result.modelText) as { time: unknown };
    expect(model.time).toEqual(
      wallClockMs === Infinity
        ? { exploration_remaining_s: null, publication_headroom_s: null }
        : { exploration_remaining_s: 720, publication_headroom_s: 180 },
    );
  },
);
