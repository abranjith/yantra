import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { DefaultSanitizer, ScriptRegistry, type AgentBrowserController } from '@yantra/core';
import { LocalRunStore } from '@yantra/core/workflow/replay';
import { createBrief } from '@yantra/protocol';

import type { AgentEvent } from '../../src/provider/types.js';
import type { AgentProgressEvent, AgentTaskConnector } from '../../src/runtime/connector.js';
import {
  runAgenticTask,
  type AgenticTaskRequest,
  type AgenticRunEnvironment,
} from '../../src/runtime/orchestrator.js';
import { resolveCommandTaskProfile } from '../../src/runtime/profiles.js';
import type { RunServices } from '../../src/runtime/run-services.js';
import { extractorReturning, searchServiceFor } from '../adapters/pi/tools/test-support.js';
import { FakeAgentProvider, type FakeSessionScript } from '../provider/fake-provider.js';

export function toolFinished(tool = 'browser_extract', code?: string): AgentEvent {
  return {
    type: 'tool_finished',
    tool,
    callId: `${tool}-${Math.random()}`,
    output:
      code === undefined
        ? { status: 'ok' }
        : { status: 'error', error_code: 'BUDGET_EXHAUSTED', details: { budget_limit: code } },
    isError: code !== undefined,
    at: new Date().toISOString(),
  };
}
export async function published(session: { readonly logPath: string }): Promise<void> {
  const root = dirname(dirname(session.logPath));
  const brief = createBrief({
    task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    title: 'Fixture result',
    overview: 'A useful partial result.',
  });
  await Promise.all(
    ['json', 'md', 'html'].map((ext) =>
      writeFile(
        join(root, `brief.${ext}`),
        ext === 'json' ? JSON.stringify(brief) : 'Fixture result',
        'utf8',
      ),
    ),
  );
}
export async function progressFixture(input: {
  readonly script: FakeSessionScript;
  readonly command?: 'do' | 'research';
  readonly budgetNow?: () => number;
  readonly budgets?: AgenticTaskRequest['budgets'];
  readonly signal?: AbortSignal;
  readonly onServices?: (services: RunServices) => void;
}) {
  const root = await mkdtemp(join(tmpdir(), 'yantra-progress-'));
  const provider = new FakeAgentProvider(input.script);
  const events: AgentProgressEvent[] = [];
  const connector: AgentTaskConnector = {
    interactive: false,
    emitAgentEvent: (e) => events.push(e),
    renderAgentOutcome: () => undefined,
    requestConfirmation: () => Promise.resolve('denied'),
  };
  const environment: AgenticRunEnvironment = {
    browserController: { teardown: () => Promise.resolve() } as Pick<
      AgentBrowserController,
      'teardown'
    >,
    domain: {
      search: {
        service: searchServiceFor({ name: 'duckduckgo', search: () => Promise.resolve([]) }),
        resultCap: 3,
        fetchTop: 0,
      },
      fetch: {
        fetcher: { fetch: () => Promise.reject(new Error('unused')) },
        extractor: extractorReturning(null),
        ethics: { check: () => Promise.resolve() },
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024,
        captureThresholdBytes: 512,
      },
      script: { registry: new ScriptRegistry() },
      publish: { publish: () => Promise.reject(new Error('unused')) },
      browser: null,
      workflow: null,
      rank: null,
    },
  };
  try {
    const outcome = await runAgenticTask(
      {
        goal: 'Read a fixture and report the result',
        profile: resolveCommandTaskProfile(input.command ?? 'do'),
        model: { provider: 'fixture', id: 'fixture-model' },
        auth: { mode: 'managed' },
        connector,
        ...(input.budgets ? { budgets: input.budgets } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      },
      {
        runStore: new LocalRunStore(root),
        sanitizer: new DefaultSanitizer(),
        createEnvironment: () => Promise.resolve(environment),
        createProvider: (services) => {
          input.onServices?.(services);
          return provider;
        },
        ...(input.budgetNow ? { budgetNow: input.budgetNow } : {}),
      },
    );
    const health = JSON.parse(
      await readFile(join(outcome.runDir, 'run-health.json'), 'utf8'),
    ) as Record<string, unknown>;
    return { outcome, events, provider, health };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}
