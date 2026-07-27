/**
 * `resolveLocatorChain` — failure classification and diagnostics.
 *
 * Every locator failure used to render as the same sentence: "Locator chain X
 * exhausted N candidate(s)." A missing `_locators` entry, a page that changed,
 * a locator matching three elements, and an element that never became
 * actionable are four different bugs with four different fixes, and none of
 * them was diagnosable from the run report.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  resolveLocatorChain,
  type LocatorResolutionResult,
} from '../../../src/executor/step-handlers/locator-helpers.js';
import type { ExecutionContext } from '../../../src/executor/types.js';
import type { EngineLocatorChain, InjectedScriptHost } from '../../../src/locator/types.js';

function makeHost(count: number): InjectedScriptHost {
  return {
    ensureInjected: vi.fn().mockResolvedValue(undefined),
    call: vi.fn().mockImplementation(async (_frameId: string, fn: string) => {
      if (fn === 'resolveCandidate') return { count, slotKey: 'default' };
      if (fn === 'checkActionableState')
        return { visible: true, enabled: true, stable: true, receivesEvents: true, attached: true };
      if (fn === 'getBoundingRect') return { top: 0, left: 0, width: 10, height: 10 };
      return undefined;
    }),
    callHandle: vi.fn().mockResolvedValue({ _fake: true }),
  };
}

function makeCtx(opts: {
  host?: InjectedScriptHost | null;
  table?: Record<string, EngineLocatorChain>;
  hasTable?: boolean;
}): ExecutionContext {
  const table = opts.table ?? {};
  return {
    locatorHost: opts.host === undefined ? makeHost(0) : opts.host,
    workflowLocators:
      opts.hasTable === false ? null : { resolve: (name: string) => table[name] ?? null },
  } as unknown as ExecutionContext;
}

function expectNotFound(
  result: LocatorResolutionResult,
): Extract<LocatorResolutionResult, { kind: 'not_found' }> {
  expect(result.kind).toBe('not_found');
  if (result.kind !== 'not_found') throw new Error('unreachable');
  return result;
}

const TIMEOUT = { timeoutMs: 50 } as const;

describe('@no-llm resolveLocatorChain diagnostics', () => {
  it('names the missing _locators entry instead of blaming the page', async () => {
    const ctx = makeCtx({ table: {} });

    const result = await resolveLocatorChain({ kind: 'workflow', name: 's3_locator' }, 's3', ctx);

    const notFound = expectNotFound(result);
    expect(notFound.chainName).toBe('s3_locator');
    expect(notFound.diagnostics).toContain('s3_locator');
    expect(notFound.diagnostics).toContain('not defined in the workflow');
  });

  it('explains a run that has no locator table at all', async () => {
    const ctx = makeCtx({ hasTable: false });

    const result = await resolveLocatorChain({ kind: 'workflow', name: 's1_locator' }, 's1', ctx);

    expect(expectNotFound(result).diagnostics).toContain('no ');
    expect(expectNotFound(result).diagnostics).toContain('locator table');
  });

  it('explains an unsupported recorded-locator reference', async () => {
    const ctx = makeCtx({});

    const result = await resolveLocatorChain({ kind: 'recorded', step_index: 4 }, 's1', ctx);

    expect(expectNotFound(result).diagnostics).toContain('recorded locator index 4');
  });

  it('flags a chain whose every recorded candidate was empty', async () => {
    // Points the author at the recording, not at the live page.
    const ctx = makeCtx({
      table: { s1_locator: { name: 's1_locator', candidates: [], strict: true } },
    });

    const result = await resolveLocatorChain({ kind: 'workflow', name: 's1_locator' }, 's1', ctx);

    const notFound = expectNotFound(result);
    expect(notFound.candidatesCount).toBe(0);
    expect(notFound.diagnostics).toContain('no usable candidates');
  });

  it('lists the candidates it actually tried when nothing matched', async () => {
    const ctx = makeCtx({
      host: makeHost(0),
      table: {
        s2_locator: {
          name: 's2_locator',
          strict: true,
          candidates: [
            {
              intent: { kind: 'role', role: 'textbox', name: 'Tracking', exact: true },
              source: 'authored',
            },
            { intent: { kind: 'css', selector: '#tn' }, source: 'authored' },
          ],
        },
      },
    });

    const result = await resolveLocatorChain(
      { kind: 'workflow', name: 's2_locator' },
      's2',
      ctx,
      TIMEOUT,
    );

    const notFound = expectNotFound(result);
    expect(notFound.candidatesCount).toBe(2);
    expect(notFound.diagnostics).toContain('role=textbox name="Tracking"');
    expect(notFound.diagnostics).toContain('css=#tn');
  });

  it('reports ambiguity distinctly from "nothing matched"', async () => {
    const ctx = makeCtx({
      host: makeHost(4),
      table: {
        s3_locator: {
          name: 's3_locator',
          strict: true,
          candidates: [
            {
              intent: { kind: 'role', role: 'button', name: 'Track', exact: true },
              source: 'authored',
            },
          ],
        },
      },
    });

    const result = await resolveLocatorChain(
      { kind: 'workflow', name: 's3_locator' },
      's3',
      ctx,
      TIMEOUT,
    );

    expect(expectNotFound(result).diagnostics).toContain('matched 4 elements');
  });

  it('surfaces a missing injected host as an error, not a locator miss', async () => {
    const ctx = makeCtx({ host: null });

    const result = await resolveLocatorChain({ kind: 'workflow', name: 's1_locator' }, 's1', ctx);

    expect(result.kind).toBe('error');
  });

  it('passes the caller requirement through to the auto-wait loop', async () => {
    // A read-only verb must be able to resolve an element that never wins the
    // centre-point hit test — the `body` locator recorded for extract steps.
    const host: InjectedScriptHost = {
      ensureInjected: vi.fn().mockResolvedValue(undefined),
      call: vi.fn().mockImplementation(async (_frameId: string, fn: string) => {
        if (fn === 'resolveCandidate') return { count: 1, slotKey: 'default' };
        if (fn === 'checkActionableState')
          return {
            visible: true,
            enabled: true,
            stable: true,
            receivesEvents: false,
            attached: true,
          };
        if (fn === 'getBoundingRect') return { top: 0, left: 0, width: 10, height: 10 };
        return undefined;
      }),
      callHandle: vi.fn().mockResolvedValue({ _fake: true }),
    };
    const table = {
      s4_locator: {
        name: 's4_locator',
        strict: true,
        candidates: [
          { intent: { kind: 'css' as const, selector: 'body' }, source: 'authored' as const },
        ],
      },
    };

    const readResult = await resolveLocatorChain(
      { kind: 'workflow', name: 's4_locator' },
      's4',
      makeCtx({ host, table }),
      { requirement: 'visible', timeoutMs: 2000 },
    );
    expect(readResult.kind).toBe('found');

    const clickResult = await resolveLocatorChain(
      { kind: 'workflow', name: 's4_locator' },
      's4',
      makeCtx({ host, table }),
      { requirement: 'actionable', timeoutMs: 300 },
    );
    expect(clickResult.kind).toBe('not_found');
  });
});
