// @no-llm
/**
 * Queue drift review (FEAT-065 TASK-017, D13).
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileInvocationStore, resetPathCache } from '@yantra/core';
import {
  formatInvocation,
  type DisplayedEffective,
  type InvocationRecord,
  type InvocationRecordInput,
} from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  compareEffective,
  driftReview,
  pinSubmitted,
  registerDriftReview,
  settingsResolver,
} from '../../../src/ui/host/drift-review.js';
import {
  RpcError,
  RpcMethodRegistry,
  type RpcCallContext,
} from '../../../src/ui/host/rpc-server.js';

const ID = '01JD2X7Q8R9S0T1V2W3X000001';
let home: string;
let previousHome: string | undefined;
let store: FileInvocationStore;

function base(
  argv: string[],
  displayed: DisplayedEffective,
  path = ['ask'],
): InvocationRecordInput {
  return {
    schema_version: 1,
    invocation_id: ID,
    invocation: { invocation_id: ID, path, argv, cwd: home },
    execution_class: 'run',
    state: 'queued',
    queued_at: '2026-11-11T10:00:00.000Z',
    updated_at: '2026-11-11T10:00:00.000Z',
    displayed_effective: displayed,
    run_id: null,
    worker: null,
    review: null,
    result: null,
  };
}

async function created(input: InvocationRecordInput): Promise<InvocationRecord> {
  return (await store.create(input)).record;
}

beforeEach(() => {
  previousHome = process.env.YANTRA_HOME;
  home = mkdtempSync(join(tmpdir(), 'yantra-drift-'));
  process.env.YANTRA_HOME = home;
  resetPathCache();
  store = new FileInvocationStore();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = previousHome;
  resetPathCache();
  rmSync(home, { recursive: true, force: true });
});

describe('with the real settings resolver', () => {
  const env = () => ({ YANTRA_HOME: home, LLM_PROVIDER: 'none' });

  async function baseline(argv: string[]): Promise<DisplayedEffective> {
    const probe = await created(base(argv, { settings: [], content: [] }));
    const current = await settingsResolver(env())(probe);
    rmSync(join(home, 'data', 'ui', 'invocations', `${ID}.json`));
    return {
      settings: current.settings.filter((s) => s.key === 'detail' || s.key === 'length'),
      content: [],
    };
  }

  it('starts directly when nothing changed', async () => {
    const displayed = await baseline(['--no-llm', 'q']);
    const record = await created(base(['--no-llm', 'q'], displayed));
    expect(await driftReview(settingsResolver(env()))(record)).toEqual([]);
  });

  it('flags a preference changed while queued, with the key and both values', async () => {
    // Arrange: queued with the default detail…
    const displayed = await baseline(['--no-llm', 'q']);
    expect(displayed.settings.find((s) => s.key === 'detail')?.value).toBe('standard');
    const record = await created(base(['--no-llm', 'q'], displayed));

    // …then the user changes the preference.
    writeFileSync(join(home, 'profile.yaml'), 'defaults:\n  detail: full\n');

    // Act
    const differences = await driftReview(settingsResolver(env()))(record);

    // Assert
    expect(differences).toEqual([
      { key: 'detail', submitted: 'standard', current: 'full', pinnable: true },
    ]);
  });

  it('pins the submitted values as flags, which the CLI format then shows', async () => {
    const displayed = await baseline(['--no-llm', 'q']);
    const record = await created(base(['--no-llm', 'q'], displayed));
    writeFileSync(join(home, 'profile.yaml'), 'defaults:\n  detail: full\n');
    const differences = await driftReview(settingsResolver(env()))(record);
    const reviewed = await store.setReview(ID, differences);

    const argv = pinSubmitted(reviewed);
    expect(argv).toEqual(['--no-llm', 'q', '--detail', 'standard']);
    const formatted = formatInvocation({ ...reviewed.invocation, argv }, 'posix');
    expect(formatted.ok && formatted.text).toContain('--detail standard');
    // With the pin, the item no longer drifts.
    const requeued = await store.requeue(ID, { argv });
    expect(await driftReview(settingsResolver(env()))(requeued)).toEqual([]);
  });
});

describe('content identities', () => {
  function sha(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  it('flags an edited workflow file, and refuses to pin the submitted version', async () => {
    // Arrange
    const workflow = join(home, 'wf.yaml');
    writeFileSync(workflow, 'v1');
    const record = await created(
      base(
        ['wf'],
        { settings: [], content: [{ kind: 'workflow', path: workflow, sha256: sha('v1') }] },
        ['run'],
      ),
    );
    writeFileSync(workflow, 'v2');

    // Act
    const differences = await driftReview(settingsResolver({ YANTRA_HOME: home }))(record);
    await store.setReview(ID, differences);
    const methods = new RpcMethodRegistry();
    registerDriftReview(methods, {
      store,
      resolve: settingsResolver({ YANTRA_HOME: home }),
      after: (next) => Promise.resolve({ state: next.state }),
    });
    const error = await methods
      .get('queue.resolve_review')!
      .handler({ invocation_id: ID, choice: 'submitted' }, {} as RpcCallContext)
      .catch((caught: unknown) => caught);

    // Assert
    expect(differences).toEqual([
      { key: `content:${workflow}`, submitted: sha('v1'), current: sha('v2'), pinnable: false },
    ]);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(-32003);
  });

  it('flags a workflow that no longer exists with current null', async () => {
    const record = await created(
      base(
        ['wf'],
        {
          settings: [],
          content: [{ kind: 'workflow', path: join(home, 'gone.yaml'), sha256: sha('x') }],
        },
        ['run'],
      ),
    );
    const differences = await driftReview(settingsResolver({ YANTRA_HOME: home }))(record);
    expect(differences[0]).toMatchObject({ current: null, pinnable: false });
  });
});

describe('compareEffective', () => {
  it('reports an env-sourced value by the variable name, never its value', async () => {
    const record = await created(
      base(['--no-llm', 'q'], {
        settings: [
          {
            key: 'provider',
            value: 'anthropic',
            source: { kind: 'env', name: 'YANTRA_AGENT_PROVIDER' },
          },
        ],
        content: [],
      }),
    );
    const differences = compareEffective(record, {
      settings: [
        {
          key: 'provider',
          value: 'ollama',
          source: { kind: 'env', name: 'YANTRA_AGENT_PROVIDER' },
        },
      ],
      content: new Map(),
    });
    expect(differences).toEqual([
      {
        key: 'provider',
        submitted: '$YANTRA_AGENT_PROVIDER',
        current: '$YANTRA_AGENT_PROVIDER',
        pinnable: false,
      },
    ]);
    expect(JSON.stringify(differences)).not.toMatch(/anthropic|ollama/u);
  });

  it('ignores settings the composer never showed', async () => {
    const record = await created(base(['--no-llm', 'q'], { settings: [], content: [] }));
    expect(
      compareEffective(record, {
        settings: [{ key: 'detail', value: 'full', source: { kind: 'flag' } }],
        content: new Map(),
      }),
    ).toEqual([]);
  });

  it('marks a key that is not a flag of this command as not pinnable', async () => {
    const record = await created(
      base(['--no-llm', 'q'], {
        settings: [{ key: 'notAnOption', value: 1, source: { kind: 'default' } }],
        content: [],
      }),
    );
    expect(compareEffective(record, { settings: [], content: new Map() })[0]?.pinnable).toBe(false);
  });
});

describe('queue.resolve_review', () => {
  async function review(choice: 'current' | 'submitted' | 'discard') {
    const record = await created(
      base(['--no-llm', 'q'], {
        settings: [{ key: 'detail', value: 'standard', source: { kind: 'default' } }],
        content: [],
      }),
    );
    const resolve = () =>
      Promise.resolve({
        settings: [
          {
            key: 'detail',
            value: 'full',
            source: { kind: 'preference' as const, key: 'defaults.detail' },
          },
        ],
        content: new Map(),
      });
    await store.setReview(ID, compareEffective(record, await resolve()));
    const methods = new RpcMethodRegistry();
    registerDriftReview(methods, {
      store,
      resolve,
      after: (next) => Promise.resolve({ state: next.state }),
    });
    return methods
      .get('queue.resolve_review')!
      .handler({ invocation_id: ID, choice }, {} as RpcCallContext);
  }

  it('discard is terminal', async () => {
    expect(await review('discard')).toEqual({ state: 'discarded' });
    await expect(store.requeue(ID)).rejects.toThrow();
  });

  it('current requeues with the current values as the new baseline', async () => {
    expect(await review('current')).toEqual({ state: 'queued' });
    expect((await store.get(ID))?.displayed_effective.settings).toEqual([
      { key: 'detail', value: 'full', source: { kind: 'preference', key: 'defaults.detail' } },
    ]);
  });

  it('submitted requeues with the value pinned', async () => {
    expect(await review('submitted')).toEqual({ state: 'queued' });
    expect((await store.get(ID))?.invocation.argv).toEqual([
      '--no-llm',
      'q',
      '--detail',
      'standard',
    ]);
  });
});
