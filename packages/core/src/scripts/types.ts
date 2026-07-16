/**
 * Shared types + defaults for the allowlisted script registry (FEAT-024
 * TASK-006). Kept dependency-free so `registry.ts` and `definitions.ts` can
 * both import it without a circular reference.
 */

import type { ZodType, ZodTypeDef } from 'zod';

/** Per-script resource limits. */
export interface ScriptLimits {
  /** Wall-clock timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Maximum serialized output size in bytes. */
  readonly maxOutputBytes: number;
  /** Best-effort old-generation heap cap in megabytes. */
  readonly memoryMb: number;
}

/**
 * A registered transformation script.
 *
 * `transform` MUST be a pure, self-contained function: it is serialized with
 * `Function.prototype.toString()` and reconstructed inside the worker, so it
 * cannot reference outer-scope variables, imports, or `this`.
 */
export interface ScriptDefinition<TArgs = unknown> {
  /** Registry key (unique, snake_case). */
  readonly id: string;
  /** Human-readable description of the transformation. */
  readonly description: string;
  /** Zod schema validating the arguments before execution (input is unknown). */
  readonly argsSchema: ZodType<TArgs, ZodTypeDef, unknown>;
  /** Resource limits enforced by the executor. */
  readonly limits: ScriptLimits;
  /** Pure, self-contained transformation function. */
  readonly transform: (args: TArgs) => unknown;
}

/** Default limits applied when a script omits an override. */
export const DEFAULT_SCRIPT_LIMITS: ScriptLimits = {
  timeoutMs: 5_000,
  maxOutputBytes: 64 * 1024,
  memoryMb: 128,
};

/** Successful or structured-failure outcome of a script run. */
export type ScriptRunOutcome =
  | { readonly ok: true; readonly output: unknown; readonly truncated: boolean }
  | {
      readonly ok: false;
      readonly errorCode: ScriptErrorCode;
      readonly message: string;
      readonly retryable: boolean;
    };

/** Stable machine codes for script run failures. */
export type ScriptErrorCode =
  | 'SCRIPT_NOT_FOUND'
  | 'SCRIPT_INVALID_ARGS'
  | 'SCRIPT_TIMEOUT'
  | 'SCRIPT_ABORTED'
  | 'SCRIPT_FAILED';
