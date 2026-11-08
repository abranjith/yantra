import type { InstallOffer } from '@yantra/core';
import type { CommandResultMessage, ConfirmationRequest } from '@yantra/protocol';

import type { InputRequest, WorkerChannel } from './channel.js';

export interface ChannelScript {
  readonly attended?: boolean;
  readonly confirmations?: readonly ('granted' | 'denied')[];
  readonly installs?: readonly boolean[];
  readonly inputs?: readonly (string | boolean | null)[];
}
/** Scripted channel for hermetic tests and embeddings; no process capabilities. */
export class InMemoryChannel implements WorkerChannel {
  readonly diagnostics: string[] = [];
  readonly events: unknown[] = [];
  readonly confirmations: ConfirmationRequest[] = [];
  readonly installs: InstallOffer[] = [];
  readonly inputs: InputRequest[] = [];
  readonly completions: CommandResultMessage[] = [];
  private readonly listeners = new Set<() => void>();
  private cancelled = false;
  private readonly confirmationAnswers: ('granted' | 'denied')[];
  private readonly installAnswers: boolean[];
  private readonly inputAnswers: (string | boolean | null)[];
  constructor(private readonly script: ChannelScript = {}) {
    this.confirmationAnswers = [...(script.confirmations ?? [])];
    this.installAnswers = [...(script.installs ?? [])];
    this.inputAnswers = [...(script.inputs ?? [])];
  }
  attended(): boolean {
    return this.script.attended === true;
  }
  diagnostic(line: string): void {
    this.diagnostics.push(line);
  }
  event(value: unknown): void {
    this.events.push(value);
  }
  requestConfirmation(
    request: ConfirmationRequest,
    signal: AbortSignal,
  ): Promise<'granted' | 'denied'> {
    this.confirmations.push(request);
    return Promise.resolve(
      signal.aborted ? 'denied' : (this.confirmationAnswers.shift() ?? 'denied'),
    );
  }
  requestInstallOffer(offer: InstallOffer, signal: AbortSignal): Promise<boolean> {
    this.installs.push(offer);
    return Promise.resolve(!signal.aborted && (this.installAnswers.shift() ?? false));
  }
  requestInput(request: InputRequest, signal: AbortSignal): Promise<string | boolean | null> {
    this.inputs.push(request);
    return Promise.resolve(signal.aborted ? null : (this.inputAnswers.shift() ?? null));
  }
  onCancel(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.cancelled) listener();
    return () => {
      this.listeners.delete(listener);
    };
  }
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of this.listeners) listener();
  }
  complete(message: CommandResultMessage): void {
    this.completions.push(message);
  }
}
