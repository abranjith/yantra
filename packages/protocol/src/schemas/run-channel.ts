import { z } from 'zod';

import { CommandInvocation, isAbsoluteCwd } from '../commands/invocation.js';

import { CommandResultMessageSchema } from './command-result.js';
import { RunEvent, isRunEventKind } from './run-event.js';

/**
 * The run channel (FEAT-064, plan §6): the per-run local socket the owner of a
 * run serves. One framing grammar, `[type: u8][length: u32 BE][payload]`:
 * type `0x01` is a UTF-8 JSON message, type `0x02` a screencast frame. Any
 * other type, or a length over its type's limit, closes the connection.
 *
 * Extensibility: capabilities are strings and an unknown message `type`
 * parses as a passthrough, so later features add messages without a
 * channel-version bump.
 */

/** The channel version this executable speaks (D17). */
export const CHANNEL_VERSION = 1 as const;

/** The range of channel versions this executable accepts. */
export const SUPPORTED_CHANNEL_VERSIONS = { min: 1, max: 1 } as const;

/** Frame type of a UTF-8 JSON message. */
export const FRAME_TYPE_JSON = 0x01 as const;
/** Frame type of a screencast frame: `[meta_len: u16 BE][meta JSON][JPEG bytes]`. */
export const FRAME_TYPE_SCREENCAST = 0x02 as const;

/** Bytes in a frame header: one type byte plus a u32 length. */
export const FRAME_HEADER_BYTES = 5 as const;
/** Largest JSON frame payload (1 MiB). */
export const MAX_JSON_FRAME_BYTES = 1_048_576 as const;
/** Largest screencast frame payload (4 MiB). */
export const MAX_SCREENCAST_FRAME_BYTES = 4_194_304 as const;
/** Largest first (`hello`) frame payload (16 KiB), enforced before authentication. */
export const MAX_HELLO_FRAME_BYTES = 16_384 as const;

/** Capability: the owner streams run events (`subscribe`, `event`). */
export const CHANNEL_CAPABILITY_EVENTS = 'events' as const;
/** Capability: the owner accepts `cancel`. */
export const CHANNEL_CAPABILITY_CANCEL = 'cancel' as const;

const VersionRange = z
  .object({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() })
  .strict()
  .describe('An inclusive range of channel versions.');

const Capabilities = z.array(z.string().min(1)).describe('Capability names.');

/**
 * A run event as carried on the channel. A kind this executable knows must
 * validate as a `RunEvent`; a kind it does not know (a newer owner) passes
 * through for the generic inspector, never an error (D17).
 */
export const RunChannelEventPayload = z
  .union([
    RunEvent,
    z
      .object({
        kind: z
          .string()
          .min(1)
          .refine((kind) => !isRunEventKind(kind), 'a known kind must validate as a RunEvent'),
      })
      .passthrough(),
  ])
  .describe('A RunEvent, or an event of a kind this executable does not know.');
export type RunChannelEventPayload = z.infer<typeof RunChannelEventPayload>;

const CLIENT_TYPES = ['hello', 'subscribe', 'cancel', 'ping'] as const;
const SERVER_TYPES = [
  'hello_ok',
  'hello_incompatible',
  'event',
  'event_oversize',
  'heartbeat',
  'cancel_ack',
  'error',
] as const;

/** A message of a type this executable does not know; parsed, never rejected. */
const unknownType = (known: readonly string[]) =>
  z
    .object({
      type: z
        .string()
        .min(1)
        .refine((type) => !known.includes(type), 'a known type must validate as its variant'),
    })
    .passthrough()
    .describe('A message of a type this executable does not know.');

const KnownClientMessage = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('hello'),
      token: z.string().min(1).describe('The lease `run_token`; compared in constant time.'),
      channel_version: z
        .number()
        .int()
        .nonnegative()
        .describe('The highest version the client speaks.'),
      capabilities: Capabilities,
      client_kind: z.enum(['host', 'cli', 'test']).describe('Who is attaching, for logs only.'),
    })
    .strict()
    .describe('First frame of every connection, within 5 s and at most 16 KiB.'),
  z
    .object({
      type: z.literal('subscribe'),
      from_seq: z
        .number()
        .int()
        .nonnegative()
        .describe('First seq wanted; replay runs from here to the watermark, then live.'),
    })
    .strict(),
  z
    .object({ type: z.literal('cancel') })
    .strict()
    .describe('Ask the owner to stop the run.'),
  z.object({ type: z.literal('ping') }).strict(),
]);

/** A message a client sends to a run owner. */
export const RunChannelClientMessage = z
  .union([KnownClientMessage, unknownType(CLIENT_TYPES)])
  .describe('A run-channel message from a client to the run owner.');
export type RunChannelClientMessage = z.infer<typeof RunChannelClientMessage>;

const KnownServerMessage = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('hello_ok'),
      channel_version: z.number().int().positive().describe('The negotiated version.'),
      supported: VersionRange,
      capabilities: Capabilities.describe('Capabilities both sides have.'),
      run_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('hello_incompatible'),
      supported: VersionRange,
      yantra_version: z.string().min(1).describe('For "Started by Yantra <version>…" (D17).'),
    })
    .strict()
    .describe('Sent instead of `hello_ok`; the connection then closes.'),
  z
    .object({
      type: z.literal('event'),
      seq: z.number().int().positive(),
      event: RunChannelEventPayload,
    })
    .strict(),
  z
    .object({ type: z.literal('event_oversize'), seq: z.number().int().positive() })
    .strict()
    .describe('Placeholder for one event whose frame would exceed 1 MiB, so no seq is missing.'),
  z.object({ type: z.literal('heartbeat'), at: z.string().datetime() }).strict(),
  z
    .object({
      type: z.literal('cancel_ack'),
      already_cancelling: z.boolean(),
      honored: z
        .boolean()
        .describe(
          'False when the running handler does not honor an abort signal; the run continues.',
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal('error'),
      code: z.enum(['unsupported', 'bad_request', 'overflow']),
      message: z.string(),
    })
    .strict(),
]);

/** A message a run owner sends to a client. */
export const RunChannelServerMessage = z
  .union([KnownServerMessage, unknownType(SERVER_TYPES)])
  .describe('A run-channel message from the run owner to a client.');
export type RunChannelServerMessage = z.infer<typeof RunChannelServerMessage>;

/** Any run-channel JSON message, in either direction. */
export const RunChannelMessage = z
  .union([RunChannelClientMessage, RunChannelServerMessage])
  .describe('A run-channel JSON message (frame type 0x01), in either direction.');
export type RunChannelMessage = z.infer<typeof RunChannelMessage>;

const absolutePath = z.string().refine(isAbsoluteCwd, 'Path must be absolute');

/** `<launchDir>/<invocation_id>.launch.json`, written by the spawner, read by the worker. */
export const WorkerLaunch = z
  .object({
    schema_version: z.literal(1),
    invocation: CommandInvocation,
    run_id: z
      .string()
      .min(1)
      .optional()
      .describe('Run ID preallocated by the host slot reservation (D11).'),
    result_path: absolutePath.describe('Where the worker writes its WorkerResult, once.'),
  })
  .strict()
  .describe(
    'What a detached worker runs. Owner-only, exclusively created; user text never reaches the worker argv.',
  );
export type WorkerLaunch = z.infer<typeof WorkerLaunch>;

/** The single result a detached worker writes atomically at `result_path`. */
export const WorkerResult = z
  .object({
    schema_version: z.literal(1),
    invocation_id: z.string().min(1),
    run_id: z.string().min(1).optional(),
    outcome: CommandResultMessageSchema,
  })
  .strict()
  .describe("A detached worker's completion: the command's result or error, written once.");
export type WorkerResult = z.infer<typeof WorkerResult>;
