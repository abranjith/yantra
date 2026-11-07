import type { ConfirmationGateway, InstallOfferGateway, Logger } from '@yantra/core';

import type { CliAgentConnectorOptions, ConnectorIO } from '../connector-io.js';
import type { OutputRenderer } from '../render/types.js';

import type { SettingsResolver } from './settings-resolver.js';

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 130;
export interface CommandResult {
  readonly exitCode: ExitCode;
  readonly failure?: {
    readonly code: string;
    readonly message: string;
    readonly remediation: string | null;
  };
}
/** Safe failure metadata; a handler may already have rendered its diagnostic. */
export class CommandFailure extends Error {
  public constructor(
    readonly exitCode: ExitCode,
    readonly code: string,
    message: string,
    readonly remediation: string | null = null,
    readonly rendered = false,
  ) {
    super(message);
    this.name = 'CommandFailure';
  }
}
export interface CommandOutput {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly columns: number | null;
  readonly colorCapable: boolean;
  json(value: unknown, options?: { readonly indent?: number }): void;
  jsonLine(value: unknown): void;
}
export interface InputCollector {
  select(message: string, choices: readonly string[]): Promise<string | null>;
  choose(choices: readonly string[]): Promise<string | null>;
  text(message: string): Promise<string | null>;
  confirm(message: string): Promise<boolean | null>;
  password(message: string): Promise<string | null>;
  stdin(): Promise<string | null>;
  editor(path: string): Promise<boolean>;
}
export interface CommandContext {
  readonly surface: 'terminal' | 'worker';
  readonly cwd: string;
  readonly invocationId: string | null;
  readonly signal: AbortSignal;
  readonly output: CommandOutput;
  readonly input: InputCollector;
  readonly settings: SettingsResolver;
  readonly logger: Logger;
  isInteractive(options: { readonly json?: boolean }): boolean;
  connector(renderer: OutputRenderer, options?: CliAgentConnectorOptions): ConnectorIO;
  readonly gateways: {
    confirmation(interactive: boolean): ConfirmationGateway | null;
    installOffer(interactive: boolean): InstallOfferGateway | null;
  };
  openExternal(path: string): void;
}
