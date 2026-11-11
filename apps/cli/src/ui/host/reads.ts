/**
 * In-process reads for the app (FEAT-065 TASK-007, plan D1).
 *
 * Every `read`-class registry path maps to an RPC method
 * `read.<path joined by '.'>`, or sits on the dated {@link UNMAPPED_READS}
 * allowlist that FEAT-070 empties. A registry test fails on any read path
 * that is neither.
 *
 * A reader runs **the same function** the command's `--json` path runs: the
 * command's own handler, in-process through the FEAT-072 worker adapter with
 * `--json` appended, and the captured document is returned as `value`.
 * `read.list` is the exception only in that it pages: it calls
 * `buildListJson`, the builder `yantra list --json` itself uses.
 *
 * A reader's failure becomes an RPC error for that call; it never reaches the
 * host.
 */

import { Writable } from 'node:stream';

import {
  COMMAND_REGISTRY,
  READ_DEFAULT_LIMIT,
  READ_MAX_LIMIT,
  ReadParams,
  ReadResult,
  createInvocationId,
  expandOptions,
  findLeaf,
  parseInvocation,
  type CommandResultMessage,
  type LeafEntry,
} from '@yantra/protocol';
import * as Protocol from '@yantra/protocol';
import { z } from 'zod';

import { runWorkerInvocation } from '../../adapters/worker/worker-adapter.js';
import { buildListJson, type ListCursorKey } from '../../commands/list.js';
import { listEnvelope } from '../../render/json.js';
import { makeStderrLogger } from '../../runtime.js';
import { UnattendedChannel } from '../../worker/entry.js';

import { RpcError, type RpcMethodRegistry } from './rpc-server.js';

/** One mapped reader. */
export interface ReaderSpec {
  /** RPC method name. */
  readonly method: string;
  /** Registry command path. */
  readonly path: readonly [string, ...string[]];
  /** Arguments always prepended (an action word such as `list`). */
  readonly fixedArgs?: readonly string[];
  /** Pages with a cursor (`read.list`). */
  readonly paged?: boolean;
}

/** The M1 readers. */
export const READERS: readonly ReaderSpec[] = [
  { method: 'read.list', path: ['list'], paged: true },
  { method: 'read.show', path: ['show'] },
  { method: 'read.audit', path: ['audit'] },
  { method: 'read.report', path: ['report'] },
  { method: 'read.prefs.list', path: ['prefs'], fixedArgs: ['list'] },
  { method: 'read.prefs.get', path: ['prefs'], fixedArgs: ['get'] },
  { method: 'read.daemon.status', path: ['daemon', 'status'] },
];

/** A `read`-class path with no reader yet; FEAT-070 empties this list. */
export interface UnmappedRead {
  readonly path: string;
  readonly since: '2026-11-03';
  readonly owner: 'FEAT-070';
}

/** Dated allowlist of read paths not mapped yet. It may only shrink. */
export const UNMAPPED_READS: readonly UnmappedRead[] = [
  'config path',
  'config list',
  'config get',
  'config validate',
  'schedules',
  'model list',
  'usage',
  'profile',
  'sites list',
  'template list',
  'template show',
  'doctor',
  'browser list',
  'browser update',
].map((path) => ({ path, since: '2026-11-03', owner: 'FEAT-070' }));

/** Every registry leaf path whose default or any rule's class is `read`. */
export function readPaths(): string[] {
  return COMMAND_REGISTRY.commands
    .filter(
      (entry): entry is LeafEntry =>
        entry.kind === 'leaf' &&
        (entry.execution.default === 'read' ||
          (entry.execution.rules ?? []).some((rule) => rule.class === 'read')),
    )
    .map((entry) => entry.path.join(' '));
}

const CursorPayload = z
  .object({ v: z.literal(1), s: z.string().datetime({ offset: true }), r: z.string().min(1) })
  .strict();

/** Encodes a list position as an opaque cursor. */
export function encodeCursor(key: ListCursorKey): string {
  return Buffer.from(JSON.stringify({ v: 1, s: key.startedAt, r: key.runId }), 'utf8').toString(
    'base64url',
  );
}

/** Decodes a cursor, or throws `invalid_params`. */
export function decodeCursor(cursor: string): ListCursorKey {
  let parsed: z.SafeParseReturnType<unknown, z.infer<typeof CursorPayload>>;
  try {
    parsed = CursorPayload.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    parsed = CursorPayload.safeParse(null);
  }
  if (!parsed.success) {
    throw new RpcError(
      'invalid_params',
      'The cursor is not one this host issued.',
      'Start again without a cursor.',
    );
  }
  return { startedAt: parsed.data.s, runId: parsed.data.r };
}

/** Clamps a requested page size to 1..200, defaulting to 50. */
export function clampLimit(limit: number | undefined): number {
  return Math.min(limit ?? READ_DEFAULT_LIMIT, READ_MAX_LIMIT);
}

/** Builds argv tokens from by-name options, refusing anything the command does not take. */
export function optionArgv(
  entry: LeafEntry,
  options: Readonly<Record<string, string | boolean>>,
): string[] {
  const specs = expandOptions(entry, COMMAND_REGISTRY.option_groups);
  const argv: string[] = [];
  for (const [name, value] of Object.entries(options)) {
    const spec = specs.find((option) => option.long === `--${name}`);
    if (spec === undefined || name === 'json') {
      throw new RpcError(
        'invalid_params',
        `${entry.path.join(' ')} has no option --${name} here.`,
        `Use only the options \`yantra ${entry.path.join(' ')} --help\` lists.`,
      );
    }
    if (spec.input.kind === 'secret-input') {
      throw new RpcError('not_allowed', `--${name} takes a secret and is never sent here.`);
    }
    if (spec.value === 'none') {
      if (typeof value !== 'boolean') {
        throw new RpcError('invalid_params', `--${name} is a switch; pass true or false.`);
      }
      if (value) argv.push(spec.long);
      continue;
    }
    if (typeof value !== 'string') {
      throw new RpcError('invalid_params', `--${name} takes a value; pass it as a string.`);
    }
    argv.push(spec.long, value);
  }
  return argv;
}

/** What a reader needs from the host. */
export interface ReadDeps {
  /** The host's environment (D13). */
  readonly env: Readonly<NodeJS.ProcessEnv>;
  /** Absolute working directory reads run in (the data directory). */
  readonly cwd: string;
  /** Runs one invocation in-process; defaults to the FEAT-072 worker adapter. */
  readonly run?: typeof runWorkerInvocation;
  readonly buildList?: typeof buildListJson;
}

const DISCARD = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

function documentOf(outcome: CommandResultMessage, method: string): unknown {
  if (outcome.type === 'error' || outcome.exit_code !== 0) {
    const message =
      outcome.type === 'error'
        ? outcome.message
        : (outcome.text ?? '').trim() || `${method} failed.`;
    const remediation = outcome.type === 'error' ? outcome.remediation : null;
    throw new RpcError(
      outcome.exit_code === 1 ? 'not_found' : 'internal_error',
      message,
      remediation ?? undefined,
    );
  }
  if (outcome.envelope !== null) return outcome.envelope;
  try {
    return JSON.parse(outcome.text ?? '') as unknown;
  } catch {
    throw new RpcError('internal_error', `${method} produced no JSON document.`);
  }
}

function validateAgainstRegistry(entry: LeafEntry, value: unknown): string | null {
  const name = entry.json?.schema ?? null;
  if (name === null) return null;
  const schema = (Protocol as Record<string, unknown>)[name];
  if (schema instanceof z.ZodType && !schema.safeParse(value).success) {
    throw new RpcError('internal_error', `The result does not match the ${name} schema.`);
  }
  return name;
}

async function runRead(
  spec: ReaderSpec,
  entry: LeafEntry,
  params: ReadParams,
  deps: ReadDeps,
): Promise<ReadResult> {
  const args = [...(spec.fixedArgs ?? []), ...(params.args ?? [])];
  const argv = [...args, ...optionArgv(entry, params.options ?? {}), '--json'];
  const invocationId = createInvocationId();
  const parsed = parseInvocation([...spec.path, ...argv], { cwd: deps.cwd, invocationId });
  if (!parsed.isOk) {
    throw new RpcError('invalid_params', parsed.error.message, 'Check the arguments and options.');
  }
  if (parsed.value.execution !== 'read') {
    throw new RpcError(
      'not_allowed',
      `${spec.path.join(' ')} with these options is ${parsed.value.execution}, not a read.`,
      'Use command.invoke for commands that change state.',
    );
  }
  const outcome = await (deps.run ?? runWorkerInvocation)(
    { invocation_id: invocationId, path: [...spec.path], argv, cwd: deps.cwd },
    new UnattendedChannel(),
    deps.env,
  );
  const value = documentOf(outcome, spec.method);
  return { schema: validateAgainstRegistry(entry, value), value, next_cursor: null };
}

async function runList(params: ReadParams, deps: ReadDeps): Promise<ReadResult> {
  const [target = 'runs', ...extra] = params.args ?? [];
  if ((target !== 'runs' && target !== 'workflows') || extra.length > 0) {
    throw new RpcError(
      'invalid_params',
      `Unknown list target "${target}".`,
      'Use runs or workflows.',
    );
  }
  const options = params.options ?? {};
  for (const name of Object.keys(options)) {
    if (name !== 'workflow' && name !== 'status') {
      throw new RpcError(
        'invalid_params',
        `read.list takes only the workflow and status options (got ${name}).`,
        'Page with limit and cursor instead of --limit.',
      );
    }
  }
  const { workflow, status } = options;
  if (
    (workflow !== undefined && typeof workflow !== 'string') ||
    (status !== undefined && typeof status !== 'string')
  ) {
    throw new RpcError('invalid_params', 'workflow and status take string values.');
  }
  const before = params.cursor === undefined ? undefined : decodeCursor(params.cursor);
  const listed = await (deps.buildList ?? buildListJson)(
    {
      target,
      limit: clampLimit(params.limit),
      ...(workflow === undefined ? {} : { workflow }),
      ...(status === undefined ? {} : { status }),
      ...(before === undefined ? {} : { before }),
    },
    { logger: makeStderrLogger(false, DISCARD), note: () => undefined },
  );
  return {
    schema: null,
    value: listEnvelope(listed.items),
    next_cursor: listed.next === null ? null : encodeCursor(listed.next),
  };
}

/** Registers every M1 reader on `methods`. */
export function registerReads(methods: RpcMethodRegistry, deps: ReadDeps): void {
  for (const spec of READERS) {
    const entry = findLeaf(spec.path);
    if (entry === undefined) throw new Error(`No registry leaf for ${spec.path.join(' ')}.`);
    methods.register(spec.method, {
      params: ReadParams,
      result: ReadResult,
      handler: (params) => {
        if (!spec.paged && (params.cursor !== undefined || params.limit !== undefined)) {
          throw new RpcError(
            'invalid_params',
            `${spec.method} is not paged.`,
            'Omit cursor and limit.',
          );
        }
        return spec.paged === true ? runList(params, deps) : runRead(spec, entry, params, deps);
      },
    });
  }
}
