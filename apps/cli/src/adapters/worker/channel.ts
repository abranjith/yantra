import type { InstallOffer } from '@yantra/core';
import type { CommandResultMessage, ConfirmationRequest } from '@yantra/protocol';

export interface InputRequest {
  readonly kind: 'select' | 'text' | 'confirm' | 'password';
  readonly message: string;
  readonly choices?: readonly string[];
}
/** Transport-independent port. FEAT-064 supplies the socket implementation. */
export interface WorkerChannel {
  attended(): boolean;
  diagnostic(line: string): void;
  event(value: unknown): void;
  requestConfirmation(
    request: ConfirmationRequest,
    signal: AbortSignal,
  ): Promise<'granted' | 'denied'>;
  requestInstallOffer(offer: InstallOffer, signal: AbortSignal): Promise<boolean>;
  requestInput(request: InputRequest, signal: AbortSignal): Promise<string | boolean | null>;
  onCancel(listener: () => void): () => void;
  complete(message: CommandResultMessage): void;
}
