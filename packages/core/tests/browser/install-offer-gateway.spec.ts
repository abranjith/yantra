import { describe, expect, it, vi } from 'vitest';

import { InteractiveInstallOfferGateway } from '../../src/browser/install-offer-gateway.js';

describe('@no-llm interactive managed-install offer', () => {
  it('fails closed outside a terminal without invoking prompts', async () => {
    const promptFn = vi.fn();
    const gateway = new InteractiveInstallOfferGateway({
      isTty: () => false,
      promptFn: promptFn as never,
    });

    await expect(
      gateway.offer({ destinationRoot: '/safe', approximateBytes: 1 }),
    ).resolves.toBeNull();
    expect(promptFn).not.toHaveBeenCalled();
  });

  it('returns interactive consent only after an affirmative answer', async () => {
    const gateway = new InteractiveInstallOfferGateway({
      isTty: () => true,
      promptFn: vi.fn().mockResolvedValue({ accepted: true }) as never,
      sink: { write: () => undefined },
    });

    await expect(
      gateway.offer({ destinationRoot: '/safe', approximateBytes: 1 }),
    ).resolves.toMatchObject({ accepted: true, source: 'interactive-offer' });
  });

  it('treats a prompt cancellation as a decline', async () => {
    const promptFn = vi
      .fn()
      .mockImplementation((_question, options: { readonly onCancel?: () => boolean }) => {
        options.onCancel?.();
        return Promise.resolve({});
      });
    const gateway = new InteractiveInstallOfferGateway({
      isTty: () => true,
      promptFn: promptFn as never,
      sink: { write: () => undefined },
    });

    await expect(
      gateway.offer({ destinationRoot: '/safe', approximateBytes: 1 }),
    ).resolves.toBeNull();
  });

  it('fails closed when the bounded prompt wait expires', async () => {
    vi.useFakeTimers();
    const gateway = new InteractiveInstallOfferGateway({
      isTty: () => true,
      promptFn: vi.fn().mockReturnValue(new Promise(() => undefined)) as never,
      timeoutMs: 25,
      sink: { write: () => undefined },
    });
    const offered = gateway.offer({ destinationRoot: '/safe', approximateBytes: 1 });

    await vi.advanceTimersByTimeAsync(25);

    await expect(offered).resolves.toBeNull();
    vi.useRealTimers();
  });
});
