/** Human-only boundary for the one optional first-run browser download offer. */
import prompts from 'prompts';

import type { ConsentSource } from './managed-install-types.js';

export interface InstallOffer {
  readonly destinationRoot: string;
  readonly approximateBytes: number;
}
export interface InstallOfferGateway {
  offer(
    offer: InstallOffer,
  ): Promise<{ readonly accepted: true; readonly source: ConsentSource } | null>;
}
export interface InteractiveInstallOfferGatewayOptions {
  readonly promptFn?: typeof prompts;
  readonly isTty?: () => boolean;
  readonly timeoutMs?: number;
  readonly sink?: { write(text: string): void };
}
export class InteractiveInstallOfferGateway implements InstallOfferGateway {
  private readonly promptFn: typeof prompts;
  private readonly isTty: () => boolean;
  private readonly timeoutMs: number;
  private readonly sink: { write(text: string): void };

  constructor(options: InteractiveInstallOfferGatewayOptions = {}) {
    this.promptFn = options.promptFn ?? prompts;
    this.isTty = options.isTty ?? (() => process.stdin.isTTY === true);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.sink = options.sink ?? process.stderr;
  }

  async offer(
    offer: InstallOffer,
  ): Promise<{ readonly accepted: true; readonly source: ConsentSource } | null> {
    if (!this.isTty()) return null;
    this.sink.write(
      `No browser is available. Download Chrome for Testing into ${offer.destinationRoot} (about ${Math.ceil(offer.approximateBytes / 1024 / 1024)} MB)?\n`,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        this.promptFn(
          {
            type: 'confirm',
            name: 'accepted',
            message: 'Download managed Chrome?',
            initial: false,
          },
          { onCancel: () => false },
        ) as Promise<{ accepted?: boolean }>,
        new Promise<{ accepted?: boolean }>((resolve) => {
          timer = setTimeout(() => resolve({ accepted: false }), this.timeoutMs);
        }),
      ]);
      return answer.accepted === true ? { accepted: true, source: 'interactive-offer' } : null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
