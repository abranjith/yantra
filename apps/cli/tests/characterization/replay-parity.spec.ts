import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import {
  resetPathCache,
  workflowsRoot,
  writeExecutionReceipt,
  type ExecutionReceiptDraft,
} from '@yantra/core';
import type { OrchestratorRunOutcome, ResumePoint } from '@yantra/core/workflow/replay';
import { createInvocationId } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../../src/adapters/terminal/terminal-adapter.js';
import { InMemoryChannel } from '../../src/adapters/worker/in-memory-channel.js';
import { runWorkerInvocation } from '../../src/adapters/worker/worker-adapter.js';
import { executeCommand } from '../../src/execute.js';
import type { CliRunOptions } from '../../src/program.js';

let home: string;
const initial: ExecutionReceiptDraft = {
  schema_version: 1,
  yantra_version: 'fixture',
  invoked_by: 'terminal',
  invocation_id: null,
  command: ['run'],
  cwd: 'C:/fixture',
  settings: [],
  content: [],
  browser: null,
};
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yantra-replay-parity-'));
  vi.stubEnv('YANTRA_HOME', home);
  resetPathCache();
  await mkdir(workflowsRoot(), { recursive: true });
  await writeFile(join(workflowsRoot(), 'fixture.yaml'), 'version: 1\nname: fixture\n');
  await writeFile(join(workflowsRoot(), 'fixture.locators.json'), '{}');
  await writeFile(join(home, 'params.yaml'), 'subject: fixture\n');
});
afterEach(async () => {
  resetPathCache();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
describe('@no-llm replay adapter parity', () => {
  it.each([
    ['run', false, false],
    ['run', true, false],
    ['run', true, true],
    ['resume', true, false],
  ] as const)(
    '%s JSON=%s failed=%s preserves outputs, receipts and exit codes',
    async (command, json, failed) => {
      const results: unknown[] = [];
      for (const surface of ['terminal', 'worker'] as const) {
        let stdout = '',
          stderr = '';
        const runDir = join(home, surface, 'run-fixed');
        await mkdir(runDir, { recursive: true });
        let original = '';
        if (command === 'resume') {
          const receipt = await writeExecutionReceipt(runDir, initial);
          original = await readFile(receipt.path, 'utf8');
        }
        const outcome: OrchestratorRunOutcome = failed
          ? ({
              kind: 'failure',
              runId: 'run-fixed',
              failureClass: 'unexpected',
              message: 'fixture failed',
            } as unknown as OrchestratorRunOutcome)
          : { kind: 'success', runId: 'run-fixed', outputs: { answer: 'fixture' } };
        const options: CliRunOptions = {
          replayRuntime: {
            recordHistory: () => Promise.resolve(),
            loadResumePoint: () =>
              Promise.resolve({
                manifest: { workflowName: 'fixture', failureClass: undefined },
                runDir,
              } as ResumePoint),
            build: () =>
              Promise.resolve({
                close: () => undefined,
                orchestrator: {
                  run: async (request) => {
                    await writeExecutionReceipt(runDir, request.receipt!);
                    return outcome;
                  },
                  resume: async (_id, request) => {
                    await writeExecutionReceipt(runDir, request!.receipt!, { resume: true });
                    return outcome;
                  },
                },
              }),
          },
        };
        const argv = [
          command === 'run' ? 'fixture' : 'run-fixed',
          '--no-llm',
          ...(command === 'run' ? ['--params-file', 'params.yaml'] : []),
          ...(json ? ['--json'] : []),
        ];
        let code: number;
        if (surface === 'terminal') {
          const context = createTerminalContext({
            env: {},
            cwd: home,
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
          code = (await executeCommand([command, ...argv], context, options)).exitCode;
        } else {
          const channel = new InMemoryChannel();
          const result = await runWorkerInvocation(
            { invocation_id: createInvocationId(), cwd: home, path: [command], argv },
            channel,
            {},
            options,
          );
          code = result.exit_code;
          stderr = channel.diagnostics.join('');
          stdout =
            result.type === 'result'
              ? result.envelope
                ? `${JSON.stringify(result.envelope, null, 2)}\n`
                : (result.text ?? '')
              : '';
        }
        const receipt = JSON.parse(
          await readFile(
            join(
              runDir,
              command === 'run' ? 'execution-receipt.json' : 'execution-receipt.resume-1.json',
            ),
            'utf8',
          ),
        ) as { content: { kind: string; path: string; sha256: string }[] };
        expect(code).toBe(failed ? 2 : 0);
        for (const identity of receipt.content)
          expect(identity.sha256).toBe(
            createHash('sha256')
              .update(await readFile(identity.path))
              .digest('hex'),
          );
        expect(receipt.content.map((v) => v.kind)).toEqual(
          command === 'run'
            ? ['workflow', 'workflow_locators', 'params_file']
            : ['workflow', 'workflow_locators'],
        );
        if (command === 'resume')
          expect(await readFile(join(runDir, 'execution-receipt.json'), 'utf8')).toBe(original);
        results.push({
          code,
          stdout,
          stderr,
          receipt: { ...receipt, invoked_by: 'surface', invocation_id: null, written_at: 'time' },
        });
      }
      expect(results[1]).toEqual(results[0]);
    },
  );
  it('hashes the workflow when execution starts after an earlier app submission', async () => {
    const invocation = {
      invocation_id: createInvocationId(),
      cwd: home,
      path: ['run'],
      argv: ['fixture', '--no-llm'],
    };
    const path = join(workflowsRoot(), 'fixture.yaml');
    await writeFile(path, 'version: 1\nname: fixture\ndescription: edited after submission\n');
    let draft: ExecutionReceiptDraft | undefined;
    await runWorkerInvocation(
      invocation,
      new InMemoryChannel(),
      {},
      {
        replayRuntime: {
          recordHistory: () => Promise.resolve(),
          build: () =>
            Promise.resolve({
              close: () => undefined,
              orchestrator: {
                run: (request) => {
                  draft = request.receipt;
                  return Promise.resolve({ kind: 'success', runId: 'fixture', outputs: {} });
                },
                resume: () => Promise.reject(new Error('unused')),
              },
            }),
        },
      },
    );
    expect(draft?.content.find((item) => item.kind === 'workflow')?.sha256).toBe(
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    );
  });
});
