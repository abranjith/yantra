import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { runScheduledFire, writeExecutionReceipt } from '@yantra/core';
import { createConfirmationStore, resetPathCache, runsRoot, workflowsRoot } from '@yantra/core';
import { createInvocationId } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../../src/adapters/terminal/terminal-adapter.js';
import { InMemoryChannel } from '../../src/adapters/worker/in-memory-channel.js';
import { runWorkerInvocation } from '../../src/adapters/worker/worker-adapter.js';
import { daemonReceipt } from '../../src/commands/daemon-runtime.js';
import { executeCommand } from '../../src/execute.js';

import { normalize } from './harness.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'yantra-scheduling-parity-'));
});
afterEach(async () => {
  resetPathCache();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
function normalized(value: unknown, home: string) {
  return normalize(JSON.stringify(value), home).replace(/[0-9A-HJKMNP-TV-Z]{26}/g, '<ulid>');
}
async function invoke(
  surface: 'terminal' | 'worker',
  path: string[],
  argv: string[],
  home: string,
) {
  let stdout = '',
    stderr = '',
    envelope: unknown = null;
  let code: number;
  if (surface === 'terminal') {
    const context = createTerminalContext({
      env: { LLM_PROVIDER: 'none' },
      cwd: root,
      isTty: false,
      stdout: new Writable({
        write(c, _e, cb) {
          stdout += String(c);
          cb();
        },
      }),
      stderr: new Writable({
        write(c, _e, cb) {
          stderr += String(c);
          cb();
        },
      }),
    });
    const json = context.output.json;
    const result = await executeCommand([...path, ...argv], {
      ...context,
      output: {
        ...context.output,
        json: (value, options) => {
          envelope = value;
          json(value, options);
        },
      },
    });
    code = result.exitCode;
    if (envelope !== null) stdout = stdout.replace(`${JSON.stringify(envelope, null, 2)}\n`, '');
  } else {
    const channel = new InMemoryChannel();
    const result = await runWorkerInvocation(
      { invocation_id: createInvocationId(), cwd: root, path, argv },
      channel,
      { LLM_PROVIDER: 'none' },
    );
    code = result.exit_code;
    stderr = channel.diagnostics.join('');
    if (result.type === 'result') {
      envelope = result.envelope;
      stdout = result.text ?? '';
    }
  }
  return {
    code,
    stdout,
    stderr,
    envelope,
    normalized: normalized({ code, stdout, stderr, envelope }, home),
  };
}
const workflow =
  'version: 1\nname: demo\ndescription: Schedule parity fixture\nsecurity_class: public\nparams: {}\nsecrets: []\ncookies: none\nsteps:\n  - id: s1\n    verb: navigate\n    url: https://fixture.example\n    scope: null\noutputs: []\n';
describe('@no-llm scheduling and confirmation adapter parity', () => {
  it('registers, lists and removes the same schedule on each surface', async () => {
    const captures: string[][] = [];
    for (const surface of ['terminal', 'worker'] as const) {
      const home = join(root, surface);
      await mkdir(home);
      vi.stubEnv('YANTRA_HOME', home);
      resetPathCache();
      await mkdir(workflowsRoot(), { recursive: true });
      await writeFile(join(workflowsRoot(), 'demo.yaml'), workflow);
      const registered = await invoke(
        surface,
        ['schedule'],
        ['demo', '--cron', '0 8 * * *', '--json'],
        home,
      );
      expect(registered.code).toBe(0);
      const id = (registered.envelope as { id: string }).id;
      const listed = await invoke(surface, ['schedules'], ['--json'], home);
      expect(listed.code).toBe(0);
      const removed = await invoke(surface, ['unschedule'], [id, '--json'], home);
      expect(removed.code).toBe(0);
      captures.push([registered.normalized, listed.normalized, removed.normalized]);
    }
    expect(captures[1]).toEqual(captures[0]);
  });
  it.each(['grant', 'deny'])(
    'writes identical parked confirmation decisions (%s)',
    async (decision) => {
      const captures: unknown[] = [];
      for (const surface of ['terminal', 'worker'] as const) {
        const home = join(root, surface);
        await mkdir(home);
        vi.stubEnv('YANTRA_HOME', home);
        resetPathCache();
        const runDir = join(runsRoot(), 'parked');
        await createConfirmationStore(runDir).appendRequest({
          confirmation_id: '01J00000000000000000000000',
          run_id: 'parked',
          step_id: 'step',
          action_kind: 'click',
          host: 'fixture.example',
          description: 'fixture action',
          expected_cost: null,
          consequence: 'reversible',
          requested_at: '2026-11-07T00:00:00.000Z',
          timeout_ms: null,
        });
        const result = await invoke(surface, ['confirm'], ['parked', decision, '--json'], home);
        expect(result.code).toBe(0);
        captures.push({
          output: result.normalized,
          decisions: normalized(await readFile(join(runDir, 'confirmations.jsonl'), 'utf8'), home),
        });
      }
      expect(captures[1]).toEqual(captures[0]);
    },
  );
  it('builds daemon receipts from schedule settings with no provider/model settings', async () => {
    vi.stubEnv('YANTRA_HOME', root);
    resetPathCache();
    await mkdir(workflowsRoot(), { recursive: true });
    await writeFile(join(workflowsRoot(), 'demo.yaml'), workflow);
    vi.stubEnv('YANTRA_AGENT_PROVIDER', 'CANARY_PROVIDER');
    vi.stubEnv('ANTHROPIC_API_KEY', 'CANARY_KEY');
    const draft = await daemonReceipt('demo', { subject: 'fixture' }, root, '0 8 * * *');
    expect(draft.invoked_by).toBe('daemon');
    expect(draft.settings.find((s) => s.key === 'params')).toMatchObject({
      source: { kind: 'schedule' },
    });
    expect(draft.content.map((v) => v.kind)).toContain('workflow');
    expect(JSON.stringify(draft)).not.toContain('CANARY');
    expect(draft.settings.some((v) => v.key === 'model' || v.key === 'provider')).toBe(false);
    const runId = 'scheduled-fixture';
    const runsDir = join(root, 'runs');
    await runScheduledFire(
      {
        id: 'fixture',
        workflowName: 'demo',
        cronExpr: '0 8 * * *',
        params: { subject: 'fixture' },
        notifyTarget: 'none',
        onConfirm: 'pause-and-notify',
        enabled: true,
        createdAt: new Date().toISOString(),
        lastFireAt: null,
        nextFireAt: null,
        lastRunId: null,
        lastStatus: null,
      },
      new Date(),
      {
        runsDir,
        receipt: () => Promise.resolve(draft),
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          debug: () => undefined,
        },
        notifier: { notify: () => Promise.resolve() },
        driver: {
          run: async (request) => {
            await writeExecutionReceipt(join(runsDir, runId), request.receipt!);
            return { kind: 'success', runId };
          },
        },
      },
    );
    const written = JSON.parse(
      await readFile(join(runsDir, runId, 'execution-receipt.json'), 'utf8'),
    ) as { invoked_by: string; settings: { key: string }[] };
    expect(written.invoked_by).toBe('daemon');
    expect(written.settings.some((setting) => setting.key === 'model')).toBe(false);
  });
});
