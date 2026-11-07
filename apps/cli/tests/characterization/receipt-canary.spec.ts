import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { runAgenticTask } from '@yantra/agent';
import {
  DeterministicSynthesizer,
  FollowUpQueryGenerator,
  ResearchLoop,
  resetPathCache,
} from '@yantra/core';
import { LocalRunStore } from '@yantra/core/workflow/replay';
import { ExecutionReceiptSchema, createInvocationId } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../../src/adapters/terminal/terminal-adapter.js';
import { InMemoryChannel } from '../../src/adapters/worker/in-memory-channel.js';
import { runWorkerInvocation } from '../../src/adapters/worker/worker-adapter.js';
import { resolveAgentInvocation } from '../../src/agent-options.js';
import { executeCommand } from '../../src/execute.js';
import type { CliRunOptions } from '../../src/program.js';

let home: string;
const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yantra-receipt-canary-'));
  vi.stubEnv('YANTRA_HOME', home);
  resetPathCache();
});
afterEach(async () => {
  resetPathCache();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true, maxRetries: 5 });
});
describe('@no-llm execution receipt canary', () => {
  it.each([false, true])(
    'keeps credentials and unrelated environment out of real run receipts (agentic=%s)',
    async (agentic) => {
      const root = join(home, 'runs');
      const options: CliRunOptions = {
        researchRuntime: {
          resolveDefaults: () => Promise.resolve(new Map()),
          resolveAgent: (command, opts, env, prefs) =>
            resolveAgentInvocation(command, opts, env, prefs, {
              probeCredential: () =>
                Promise.resolve({ available: true, authSource: 'keychain-CANARY_KEYCHAIN' }),
            }),
          runTask: (request) =>
            runAgenticTask(request, {
              runStore: new LocalRunStore(root),
              createEnvironment: () => Promise.reject(new Error('fixture provider refused')),
            }),
          createLoop: () =>
            Promise.resolve(
              new ResearchLoop({
                runRootDir: root,
                logger,
                searchProvider: { name: 'duckduckgo', search: () => Promise.resolve([]) },
                fetcher: { fetch: () => Promise.reject(new Error('unused')) },
                extractor: { extract: () => Promise.resolve(null) },
                ethicsGate: { checkUrl: () => Promise.resolve({ ok: true }) },
                synthesizer: new DeterministicSynthesizer(),
                queryGen: new FollowUpQueryGenerator(),
              }),
            ),
        },
      };
      const env = {
        ANTHROPIC_API_KEY: 'CANARY_PROVIDER',
        UNRELATED_TOKEN: 'CANARY_UNRELATED',
        ...(agentic ? {} : { LLM_PROVIDER: 'none' }),
      };
      const sink = new Writable({
        write(_c, _e, cb) {
          cb();
        },
      });
      const context = createTerminalContext({
        env,
        cwd: home,
        isTty: false,
        stdout: sink,
        stderr: sink,
      });
      const argv = ['x', '--json', ...(agentic ? [] : ['--no-llm'])];
      await executeCommand(['research', ...argv], context, options);
      const channel = new InMemoryChannel();
      await runWorkerInvocation(
        { invocation_id: createInvocationId(), cwd: home, path: ['research'], argv },
        channel,
        env,
        options,
      );
      const directories = await readdir(root);
      expect(directories).toHaveLength(2);
      const receipts = await Promise.all(
        directories.map(async (id) => {
          const bytes = await readFile(join(root, id, 'execution-receipt.json'), 'utf8');
          expect(bytes).not.toContain('CANARY');
          expect(bytes).not.toContain('UNRELATED_TOKEN');
          expect(bytes).not.toContain('ANTHROPIC_API_KEY');
          return ExecutionReceiptSchema.parse(JSON.parse(bytes));
        }),
      );
      const normalize = (receipt: (typeof receipts)[number]) => ({
        ...receipt,
        run_id: 'normalized',
        invoked_by: 'normalized',
        invocation_id: null,
        written_at: 'normalized',
      });
      expect(normalize(receipts[0]!)).toEqual(normalize(receipts[1]!));
    },
  );
});
