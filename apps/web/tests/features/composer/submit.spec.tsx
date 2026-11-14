import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { isAbsoluteCwd, type EffectiveOptions, type InvocationSummary } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { buildComposerModel } from '../../../src/features/composer/composer-model.js';
import {
  SUBMIT_RETRIES,
  SubmitLostError,
  SubmitRefusedError,
  displayedEffective,
  submitBackoffMs,
  submitInvocation,
} from '../../../src/features/composer/submit.js';
import { RpcCallError, RpcDisconnectedError } from '../../../src/host/rpc-client.js';
import { FakeRpc, renderAt } from '../../support/fake-rpc.js';

const HOME = process.platform === 'win32' ? 'C:\\Users\\u' : '/home/u';

const EFFECTIVE: EffectiveOptions = {
  path: ['research'],
  mode: 'deterministic',
  options: [
    { option: 'llm', flag: '--no-llm', value: false, source: { kind: 'flag' } },
    { option: 'length', flag: '--length', value: 'long', source: { kind: 'default' } },
  ],
};

function model() {
  return buildComposerModel({
    path: 'research',
    values: { positional: 'quiet laptops', options: { llm: true } },
    effective: EFFECTIVE,
  });
}

/** An idempotent host: one record per invocation ID, whatever the retries. */
class IdempotentHost extends FakeRpc {
  public readonly records = new Map<string, InvocationSummary>();
  public losses = 0;

  public constructor() {
    super();
    this.answer('command.invoke', (params) => {
      const invocation = params.invocation as { invocation_id: string; path: string[] };
      const record: InvocationSummary = this.records.get(invocation.invocation_id) ?? {
        invocation_id: invocation.invocation_id,
        state: 'spawning',
        execution_class: 'run',
        path: invocation.path,
        run_id: null,
        queued_at: '2026-11-14T10:00:00.000Z',
        review: null,
        result: null,
      };
      this.records.set(invocation.invocation_id, record);
      if (this.losses > 0) {
        this.losses -= 1;
        throw new RpcDisconnectedError('command.invoke');
      }
      return record;
    });
  }
}

const instant = { sleep: () => Promise.resolve() };

describe('@no-llm submitInvocation', () => {
  it('retries a lost response with the same ID, and the host keeps one record', async () => {
    const host = new IdempotentHost();
    host.losses = 1;

    const { summary, invocation } = await submitInvocation(
      host,
      { model: model(), effective: EFFECTIVE, cwd: HOME },
      { ...instant, createId: () => '01JD2X7Q8R9S0T1V2W3X000031' },
    );

    const ids = host
      .paramsOf('command.invoke')
      .map((params) => (params.invocation as { invocation_id: string }).invocation_id);
    expect(ids).toEqual(['01JD2X7Q8R9S0T1V2W3X000031', '01JD2X7Q8R9S0T1V2W3X000031']);
    expect(host.records.size).toBe(1);
    expect(summary.invocation_id).toBe('01JD2X7Q8R9S0T1V2W3X000031');
    expect(invocation).toEqual({
      invocation_id: '01JD2X7Q8R9S0T1V2W3X000031',
      path: ['research'],
      argv: ['quiet laptops', '--no-llm'],
      cwd: HOME,
    });
  });

  it('retries an attempt that times out, then gives up after three retries', async () => {
    const host = new IdempotentHost();
    const waits: number[] = [];

    const failure = await submitInvocation(
      host,
      { model: model(), effective: EFFECTIVE, cwd: HOME },
      {
        createId: () => '01JD2X7Q8R9S0T1V2W3X000032',
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
        timeout: () => Promise.reject(new Error('no answer')),
      },
    ).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(SubmitLostError);
    expect((failure as SubmitLostError).invocationId).toBe('01JD2X7Q8R9S0T1V2W3X000032');
    expect(host.paramsOf('command.invoke')).toHaveLength(SUBMIT_RETRIES + 1);
    expect(waits).toEqual([1, 2, 3].map(submitBackoffMs));
  });

  it('does not retry a refusal; it is the answer', async () => {
    const host = new FakeRpc().answer('command.invoke', () => {
      throw new RpcCallError(
        'command.invoke',
        -32002,
        'The browser profile is in use by run r-1.',
        'busy',
        'Wait for it to finish.',
      );
    });

    const refused = await submitInvocation(
      host,
      { model: model(), effective: EFFECTIVE, cwd: HOME },
      instant,
    ).catch((caught: unknown) => caught);

    expect(refused).toBeInstanceOf(SubmitRefusedError);
    expect(refused).toMatchObject({
      message: 'The browser profile is in use by run r-1.',
      reason: 'busy',
      remediation: 'Wait for it to finish.',
    });
    expect(host.paramsOf('command.invoke')).toHaveLength(1);
  });

  it('sends what the composer showed as the drift baseline', async () => {
    const host = new IdempotentHost();

    await submitInvocation(host, { model: model(), effective: EFFECTIVE, cwd: HOME }, instant);

    expect(host.paramsOf('command.invoke')[0]?.displayed_effective).toEqual(
      displayedEffective(EFFECTIVE),
    );
    expect(displayedEffective(EFFECTIVE)).toEqual({
      settings: [
        { key: 'llm', value: false, source: { kind: 'flag' } },
        { key: 'length', value: 'long', source: { kind: 'default' } },
      ],
      content: [],
    });
    expect(displayedEffective(null)).toEqual({ settings: [], content: [] });
  });

  it('mints a fresh ID per submission that matches the host’s pattern', async () => {
    const host = new IdempotentHost();

    const first = await submitInvocation(
      host,
      { model: model(), effective: null, cwd: HOME },
      instant,
    );
    const second = await submitInvocation(
      host,
      { model: model(), effective: null, cwd: HOME },
      instant,
    );

    expect(first.invocation.invocation_id).not.toBe(second.invocation.invocation_id);
    expect(first.invocation.invocation_id).toMatch(/^[A-Za-z0-9_-]{16,64}$/u);
  });
});

describe('@no-llm submit from the Mission page', () => {
  function mission(host: FakeRpc): FakeRpc {
    return host
      .answer('read.mission_context', { home: HOME, platform: process.platform })
      .answer('read.template.list', { schema: null, value: { items: [] }, next_cursor: null })
      .answer('read.effective_options', EFFECTIVE)
      .answer('read.invocation', (params) => ({
        invocation_id: params.invocation_id,
        state: 'queued',
        execution_class: 'run',
        path: ['ask'],
        position: 1,
        run_id: null,
        queued_at: '2026-11-14T10:00:00.000Z',
        review: null,
        result: null,
      }));
  }

  it('sends one invocation for a double click, from an absolute working directory, and follows it', async () => {
    const host = mission(new IdempotentHost());
    const { router } = await renderAt('/mission', host);
    await userEvent.type(await screen.findByRole('textbox', { name: /Question/u }), 'what is new');

    await userEvent.dblClick(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toMatch(/^\/mission\/invocations\//u);
    });
    expect(host.paramsOf('command.invoke')).toHaveLength(1);
    const invocation = host.paramsOf('command.invoke')[0]!.invocation as {
      cwd: string;
      argv: string[];
    };
    expect(isAbsoluteCwd(invocation.cwd)).toBe(true);
    expect(invocation.argv).toEqual(['what is new']);
  });

  it('shows a refusal inline and keeps what was typed', async () => {
    const host = mission(new FakeRpc()).answer('command.invoke', () => {
      throw new RpcCallError(
        'command.invoke',
        -32602,
        "error: option '--depth <n>' argument '9' is invalid.",
        'invalid_params',
        'Check the arguments and options.',
      );
    });
    await renderAt('/mission', host);
    const goal = await screen.findByRole('textbox', { name: /Question/u });
    await userEvent.type(goal, 'what is new');

    await userEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      "error: option '--depth <n>' argument '9' is invalid. Check the arguments and options.",
    );
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: /Question/u }).value).toBe(
      'what is new',
    );
  });
});
