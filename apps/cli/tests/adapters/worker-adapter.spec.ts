import { createInvocationId, type CommandInvocation } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { InMemoryChannel } from '../../src/adapters/worker/in-memory-channel.js';
import { runWorkerInvocation } from '../../src/adapters/worker/worker-adapter.js';
import { CommandFailure } from '../../src/context/command-context.js';
import type { Handler } from '../../src/registry/handler.js';

const invocation = (path = ['research'], argv = ['x']): CommandInvocation => ({
  invocation_id: createInvocationId(),
  cwd: 'C:/worker/requested',
  path,
  argv,
});
describe('@no-llm worker adapter', () => {
  it.each([
    ['secret', 'set'],
    ['config', 'data-dir'],
  ])('refuses the designated surface %s %s', async (...path) => {
    const channel = new InMemoryChannel();
    const argv = path[0] === 'secret' ? ['fixture.key'] : ['C:/fixture-data'];
    expect(await runWorkerInvocation(invocation(path, argv), channel, {})).toMatchObject({
      type: 'error',
      exit_code: 1,
      code: 'not_worker_executable',
    });
    expect(channel.completions).toHaveLength(1);
  });
  it('uses explicit cwd and an immutable environment snapshot', async () => {
    const channel = new InMemoryChannel();
    const result = await runWorkerInvocation(
      invocation(),
      channel,
      { FIXTURE: 'value' },
      {
        handlers: {
          research: (_a, _o, _c, context) => {
            context!.output.json({ cwd: context!.cwd, env: context!.settings.env().FIXTURE });
          },
        },
      },
    );
    expect(result).toMatchObject({
      type: 'result',
      envelope: { cwd: 'C:/worker/requested', env: 'value' },
      text: null,
    });
  });
  it('caps UTF-8 human text at 64 KiB with a truncation marker', async () => {
    const channel = new InMemoryChannel();
    const result = await runWorkerInvocation(
      invocation(),
      channel,
      {},
      {
        handlers: {
          research: (_a, _o, _c, context) => {
            context!.output.stdout.write('\u6587'.repeat(100_000));
          },
        },
      },
    );
    expect(result.type).toBe('result');
    if (result.type === 'result') {
      expect(Buffer.byteLength(result.text!)).toBeLessThanOrEqual(64 * 1024);
      expect(result.text).toContain('[output truncated]');
      expect(result.text).not.toContain('\ufffd');
    }
  });
  it.each([false, true])(
    'makes confirmation and input depend on attendance (%s)',
    async (attended) => {
      const channel = new InMemoryChannel({
        attended,
        installs: [true],
        inputs: ['fixture answer'],
      });
      await runWorkerInvocation(
        invocation(),
        channel,
        {},
        {
          handlers: {
            research: async (_a, _o, _c, context) => {
              expect(context!.isInteractive({ json: true })).toBe(attended);
              expect(context!.gateways.confirmation(attended) !== null).toBe(attended);
              const offer = context!.gateways.installOffer(attended);
              if (offer)
                expect(
                  await offer.offer({ destinationRoot: 'C:/fixture', approximateBytes: 1 }),
                ).toMatchObject({ accepted: true });
              expect(await context!.input.text('fixture prompt')).toBe(
                attended ? 'fixture answer' : null,
              );
            },
          },
        },
      );
      expect(channel.inputs).toHaveLength(attended ? 1 : 0);
      expect(channel.installs).toHaveLength(attended ? 1 : 0);
    },
  );
  it('maps an uncaught exception to a typed error completion', async () => {
    const channel = new InMemoryChannel();
    expect(
      await runWorkerInvocation(
        invocation(),
        channel,
        {},
        {
          handlers: {
            research: () => {
              throw new Error('fixture failed');
            },
          },
        },
      ),
    ).toMatchObject({
      type: 'error',
      exit_code: 2,
      code: 'command_failed',
      message: 'fixture failed',
    });
    expect(channel.completions).toHaveLength(1);
  });
  it('preserves cancellation 130 and disposes cancellation listeners after completion', async () => {
    const channel = new InMemoryChannel();
    const handler: Handler = () => {
      throw new CommandFailure(130, 'aborted', 'cancelled');
    };
    expect(
      await runWorkerInvocation(invocation(), channel, {}, { handlers: { research: handler } }),
    ).toMatchObject({ type: 'error', exit_code: 130, code: 'aborted' });
    channel.cancel();
    expect(channel.diagnostics).not.toContain('cancel_unsupported');
  });
  it('reports unsupported cancellation without aborting unrelated work', async () => {
    const channel = new InMemoryChannel();
    const handler: Handler = () => {
      channel.cancel();
    };
    expect(
      (await runWorkerInvocation(invocation(), channel, {}, { handlers: { research: handler } }))
        .exit_code,
    ).toBe(0);
    expect(channel.diagnostics).toContain('cancel_unsupported');
  });
});
