import { z } from 'zod';

/**
 * The app ↔ host channel (FEAT-065 TASK-004): JSON-RPC 2.0 over a loopback
 * WebSocket at `/rpc`.
 *
 * The first message on every socket is {@link AppRpcAuth}; anything else (or
 * nothing within 5 s) closes the socket with code 4401 and no reply. After
 * that, requests, responses and notifications follow JSON-RPC 2.0. Every
 * error's `data` says what happened and one next step.
 *
 * Methods are added by later features (`read.*`, `run.*`, `command.*`, …);
 * each method's params and result are Zod schemas in this module, so the
 * protocol documentation derives from their descriptions.
 */

/** WebSocket close code: authentication failed or the session ended. */
export const APP_RPC_CLOSE_UNAUTHORIZED = 4401 as const;

/** Largest WebSocket message either side sends (1 MiB). */
export const MAX_APP_RPC_MESSAGE_BYTES = 1_048_576 as const;

/** JSON-RPC request IDs: a string, a number, or null. */
export const JsonRpcId = z
  .union([z.string(), z.number(), z.null()])
  .describe('Request ID; echoed unchanged in the response.');
export type JsonRpcId = z.infer<typeof JsonRpcId>;

/** A JSON-RPC 2.0 request (with `id`) or notification (without). */
export const JsonRpcRequest = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: z.string().min(1).describe('Method name, e.g. `host.hello` or `read.list`.'),
    params: z
      .union([z.record(z.unknown()), z.array(z.unknown())])
      .optional()
      .describe('By-name (object) parameters; by-position arrays are refused per method.'),
    id: JsonRpcId.optional().describe('Absent for a notification, which gets no response.'),
  })
  .strict()
  .describe('A JSON-RPC 2.0 request or notification.');
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;

/** The app error codes, beside the JSON-RPC standard ones. */
export const AppRpcErrorCode = {
  parse_error: -32700,
  invalid_request: -32600,
  method_not_found: -32601,
  invalid_params: -32602,
  internal_error: -32603,
  unauthorized: -32001,
  busy: -32002,
  not_allowed: -32003,
  not_found: -32004,
  too_large: -32005,
  needs_confirmation: -32006,
} as const;
export type AppRpcErrorName = keyof typeof AppRpcErrorCode;

/** What every error's `data` carries. */
export const AppRpcErrorData = z
  .object({
    code: z.string().min(1).describe('Stable machine-readable reason, e.g. `invalid_params`.'),
    message: z.string().min(1).describe('What actually happened.'),
    remediation: z.string().min(1).optional().describe('One next step, when there is one.'),
  })
  .strict()
  .describe('Detail of a JSON-RPC error.');
export type AppRpcErrorData = z.infer<typeof AppRpcErrorData>;

/** A JSON-RPC 2.0 error object. */
export const JsonRpcErrorObject = z
  .object({
    code: z
      .number()
      .int()
      .describe('A JSON-RPC standard code or an app code from AppRpcErrorCode.'),
    message: z.string().min(1),
    data: AppRpcErrorData,
  })
  .strict();
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObject>;

/** A JSON-RPC 2.0 response: exactly one of `result` or `error`. */
export const JsonRpcResponse = z
  .union([
    z.object({ jsonrpc: z.literal('2.0'), id: JsonRpcId, result: z.unknown() }).strict(),
    z.object({ jsonrpc: z.literal('2.0'), id: JsonRpcId, error: JsonRpcErrorObject }).strict(),
  ])
  .describe('A JSON-RPC 2.0 response.');
export type JsonRpcResponse = z.infer<typeof JsonRpcResponse>;

/** A host → app notification. */
export const JsonRpcNotification = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: z.string().min(1),
    params: z.record(z.unknown()),
  })
  .strict()
  .describe('A host → app notification (no `id`).');
export type JsonRpcNotification = z.infer<typeof JsonRpcNotification>;

/** The first message on every socket. */
export const AppRpcAuth = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: z.literal('auth'),
    params: z
      .object({
        window_capability: z
          .string()
          .min(1)
          .max(128)
          .describe('The capability returned by POST /session; held in memory only.'),
      })
      .strict(),
  })
  .strict()
  .describe('First message on every socket; must match the cookie’s window.');
export type AppRpcAuth = z.infer<typeof AppRpcAuth>;

/** `host.hello` params. */
export const HostHelloParams = z
  .object({
    build_id: z.string().min(1).describe('The build ID in the page’s `yantra-build-id` meta tag.'),
    channel_version: z
      .number()
      .int()
      .positive()
      .describe('The app channel version the page speaks.'),
  })
  .strict();
export type HostHelloParams = z.infer<typeof HostHelloParams>;

/** `host.hello` result. */
export const HostHelloResult = z
  .object({
    build_id: z
      .string()
      .min(1)
      .describe('The build the host serves; a mismatch means stale assets (D17).'),
    channel_version: z.number().int().positive(),
    yantra_version: z.string().min(1),
    server_time: z.string().datetime().describe('The host clock, for the app’s relative times.'),
  })
  .strict();
export type HostHelloResult = z.infer<typeof HostHelloResult>;

/** `host.build` notification, sent on every connect (D17). */
export const HostBuildNotification = z
  .object({ build_id: z.string().min(1) })
  .strict()
  .describe('The build the host serves, repeated on every connect.');
export type HostBuildNotification = z.infer<typeof HostBuildNotification>;

/** Params of methods that take none. */
export const EmptyParams = z.object({}).strict().describe('No parameters.');
export type EmptyParams = z.infer<typeof EmptyParams>;

/** `session.resume_code` / `session.launch_code` result: a window-bound single-use code. */
export const SessionCodeResult = z
  .object({
    code: z
      .string()
      .min(1)
      .describe('Single-use code, valid for 60 seconds, bound to this window.'),
    expires_at: z.string().datetime(),
  })
  .strict();
export type SessionCodeResult = z.infer<typeof SessionCodeResult>;

/** `POST /session` success body. */
export const SessionGrantResponse = z
  .object({
    window_id: z.string().min(1),
    window_capability: z.string().min(1),
    build_id: z.string().min(1),
    absolute_expiry: z.string().datetime(),
  })
  .strict()
  .describe('A window session; the capability is kept in memory only.');
export type SessionGrantResponse = z.infer<typeof SessionGrantResponse>;

/** Default page size of a paged read. */
export const READ_DEFAULT_LIMIT = 50 as const;
/** Largest page size of a paged read; larger requests are clamped. */
export const READ_MAX_LIMIT = 200 as const;

/** Params of every `read.<command path>` method. */
export const ReadParams = z
  .object({
    args: z
      .array(z.string())
      .max(16)
      .optional()
      .describe('Positional arguments, exactly as on the command line.'),
    options: z
      .record(z.union([z.string(), z.boolean()]))
      .optional()
      .describe(
        'Options by long name without dashes (e.g. `{"status":"failed"}`); `true` sets a switch.',
      ),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Opaque cursor from a previous page’s `next_cursor` (paged reads only).'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Page size (paged reads only); default 50, clamped to 200.'),
  })
  .strict()
  .describe('Arguments of an in-process read.');
export type ReadParams = z.infer<typeof ReadParams>;

/** Result of every `read.<command path>` method. */
export const ReadResult = z
  .object({
    schema: z
      .string()
      .nullable()
      .describe('The registry `--json` schema name, or null when the shape is not yet described.'),
    value: z.unknown().describe('Exactly what `yantra <command> --json` prints, parsed.'),
    next_cursor: z
      .string()
      .nullable()
      .describe('Cursor for the next page; null on the last page or for unpaged reads.'),
  })
  .strict()
  .describe('The result of an in-process read.');
export type ReadResult = z.infer<typeof ReadResult>;
