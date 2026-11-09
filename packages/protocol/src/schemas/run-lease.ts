import { z } from 'zod';

import { ExecutionClass } from '../commands/schema.js';

/**
 * Run ownership (FEAT-064): who owns a run directory, and how to reach it.
 *
 * A run is owned by exactly one process through `<runDir>/lease.json`, claimed
 * by an exclusive `link` and **never rewritten while the owner runs**: on
 * Windows a rename over a file any reader holds open fails, so mutable
 * ownership state lives in the append-only `owned-browsers.jsonl` instead
 * (spike S2, RC2). Liveness is decided by creation identity, never by a bare
 * PID or by age.
 */

/** Envelope version of `lease.json` and `owned-browsers.jsonl` lines. */
export const RUN_LEASE_SCHEMA_VERSION = 1 as const;

/** A run token: 32 random bytes, base64url without padding (43 characters). */
export const RUN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The start-token value meaning "the platform could not tell"; never treated as dead. */
export const UNKNOWN_START_TOKEN_VALUE = 'unknown' as const;

/**
 * Whether a run's owner died before it could end the run itself. Present only
 * on a run a reconciler ended (FEAT-064 D7), separately from the evidence-based
 * `taskOutcome`; absent for every run that ended on its own.
 */
export const ExecutionState = z
  .enum(['interrupted'])
  .describe(
    'Set only by the reconciler when the owning process died before writing a terminal result (plan D7). Separate from the outcome, which follows the evidence and is never `aborted`. Absent for every run that ended on its own.',
  );
export type ExecutionState = z.infer<typeof ExecutionState>;

/** A process creation identity, as recorded on disk. */
export const ProcessIdentityRecord = z
  .object({
    pid: z.number().int().positive().describe('Process ID.'),
    start_token: z
      .string()
      .min(1)
      .describe(
        'Creation identity (platform start time). `unknown` when the platform could not tell; a liveness check then answers `unknown`, never `dead`.',
      ),
  })
  .strict()
  .describe('A process creation identity: a PID plus its start token.');
export type ProcessIdentityRecord = z.infer<typeof ProcessIdentityRecord>;

/** Who launched the run. */
export const RunLeaseOrigin = z
  .enum(['terminal', 'worker', 'daemon'])
  .describe('Who launched the run: a terminal command, a detached app worker, or the daemon.');
export type RunLeaseOrigin = z.infer<typeof RunLeaseOrigin>;

const PIPE_ADDRESS = /^\\\\\.\\pipe\\yantra-[0-9a-f]{32}$/;
const UNIX_ADDRESS = /^\/.*\/[0-9a-f]{24}\.sock$/;

/** Where the owner serves its run socket. */
export const RunSocketAddress = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('unix'),
        address: z
          .string()
          .regex(UNIX_ADDRESS)
          .describe('Absolute Unix socket path `<owner-only dir>/<24 hex>.sock`.'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('pipe'),
        address: z
          .string()
          .regex(PIPE_ADDRESS)
          .describe('Windows named pipe `\\\\.\\pipe\\yantra-<32 hex>`.'),
      })
      .strict(),
  ])
  .describe('The run socket address: a Unix socket in an owner-only directory, or a named pipe.');
export type RunSocketAddress = z.infer<typeof RunSocketAddress>;

/**
 * `<runDir>/lease.json`. Unknown keys are stripped rather than rejected, so a
 * host can still read a lease written by a newer owner (D17).
 */
export const RunLease = z
  .object({
    schema_version: z.literal(RUN_LEASE_SCHEMA_VERSION).describe('Lease envelope version.'),
    run_id: z.string().min(1).describe('The owned run; equals the run directory name.'),
    owner: ProcessIdentityRecord.describe('Creation identity of the owning process.'),
    origin: RunLeaseOrigin,
    execution_class: ExecutionClass.describe(
      "The command registry's execution class for the invocation (normally `run`).",
    ),
    command: z
      .array(z.string().min(1))
      .nonempty()
      .describe('Command path, for example `["research"]`. Display only.'),
    socket: RunSocketAddress,
    run_token: z
      .string()
      .regex(RUN_TOKEN_PATTERN)
      .describe(
        'Secret that authenticates run-socket clients (32 random bytes, base64url). Never logged, never sent to the model or served to the app.',
      ),
    channel_version: z
      .number()
      .int()
      .positive()
      .describe('Highest run-channel version the owner speaks (D17).'),
    yantra_version: z
      .string()
      .min(1)
      .describe('Version of the Yantra executable that owns the run.'),
    log_seq_at_claim: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Last committed `run-events.jsonl` seq at claim: the start of this ownership epoch. A reconciler looks for a terminal event only above it.',
      ),
    claimed_at: z.string().datetime().describe('When the lease was claimed.'),
  })
  .describe(
    'Exclusive ownership of a run directory, written once by `link` and removed only after the terminal event and manifest are flushed. Owner-only file.',
  );
export type RunLease = z.infer<typeof RunLease>;

/** One line of `<runDir>/owned-browsers.jsonl`. */
export const OwnedBrowserEvent = z
  .object({
    schema_version: z.literal(RUN_LEASE_SCHEMA_VERSION),
    op: z
      .enum(['spawned', 'exited'])
      .describe(
        '`spawned` as soon as a browser child handle exists; `exited` only after its exit is proved.',
      ),
    pid: z.number().int().positive(),
    start_token: z
      .string()
      .min(1)
      .describe('Creation identity; `unknown` keeps the entry uncertain.'),
    at: z.string().datetime(),
  })
  .strict()
  .describe(
    'An append-only record of a browser process the run spawned or proved exited. Readers fold the lines by identity and ignore a trailing partial line.',
  );
export type OwnedBrowserEvent = z.infer<typeof OwnedBrowserEvent>;
