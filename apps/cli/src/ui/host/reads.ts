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
 * `read.list` is the exception: it pages the Ledger through `queryRunLedger`
 * (FEAT-066), the core query `yantra list` itself uses; see `ledger-reads.ts`.
 *
 * A reader's failure becomes an RPC error for that call; it never reaches the
 * host.
 */

import { Writable } from 'node:stream';

import {
  COMMAND_REGISTRY,
  ReadParams,
  ReadResult,
  createInvocationId,
  expandOptions,
  findLeaf,
  parseInvocation,
  type CommandResultMessage,
  type LeafEntry,
  type ListResult,
} from '@yantra/protocol';
import * as Protocol from '@yantra/protocol';
import { z } from 'zod';

// The command surface is loaded on the first read, not at host start: it is
// most of the CLI's module graph and would delay the host becoming ready.
import type { runWorkerInvocation } from '../../adapters/worker/worker-adapter.js';
import type { buildListJson } from '../../commands/list.js';

import { registerLedgerRead, type LedgerReadDeps } from './ledger-reads.js';
import { RpcError, type RpcMethodRegistry } from './rpc-server.js';

/** One mapped reader. */
export interface ReaderSpec {
  /** RPC method name. */
  readonly method: string;
  /** Registry command path. */
  readonly path: readonly [string, ...string[]];
  /** Arguments always prepended (an action word such as `list`). */
  readonly fixedArgs?: readonly string[];
  /** Pages with a cursor: `read.list`, registered by `ledger-reads.ts`. */
  readonly paged?: boolean;
  /** Registered by `run-reads.ts` with typed params (FEAT-066), not the generic reader. */
  readonly runRead?: boolean;
}

/** The M1 readers. */
export const READERS: readonly ReaderSpec[] = [
  { method: 'read.list', path: ['list'], paged: true },
  { method: 'read.show', path: ['show'] },
  { method: 'read.audit', path: ['audit'], runRead: true },
  { method: 'read.report', path: ['report'], runRead: true },
  { method: 'read.prefs.list', path: ['prefs'], fixedArgs: ['list'] },
  { method: 'read.prefs.get', path: ['prefs'], fixedArgs: ['get'] },
  // The effective profile with defaults and provenance: what the app applies (TASK-011).
  { method: 'read.profile', path: ['profile'] },
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
  /** Runs the host knows are in progress, for the Ledger's active region. */
  readonly activeRuns?: LedgerReadDeps['activeRuns'];
  /** Opens the history index; defaults to the CLI's `openHistory`. */
  readonly openHistory?: LedgerReadDeps['openHistory'];
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
  const run =
    deps.run ?? (await import('../../adapters/worker/worker-adapter.js')).runWorkerInvocation;
  const { UnattendedChannel } = await import('../../worker/entry.js');
  const outcome = await run(
    { invocation_id: invocationId, path: [...spec.path], argv, cwd: deps.cwd },
    new UnattendedChannel(),
    deps.env,
  );
  const value = documentOf(outcome, spec.method);
  return { schema: validateAgainstRegistry(entry, value), value, next_cursor: null };
}

/** `list workflows` in the app: every saved workflow, up to the CLI's own cap. */
const WORKFLOW_LIST_LIMIT = 500;

/** The `read.list` dependencies over this host's environment. */
function ledgerDeps(deps: ReadDeps): LedgerReadDeps {
  const quietLogger = async () =>
    (await import('../../runtime.js')).makeStderrLogger(false, DISCARD);
  return {
    openHistory: deps.openHistory ?? (async () => (await import('../../history.js')).openHistory()),
    listWorkflows: async () => {
      const buildList = deps.buildList ?? (await import('../../commands/list.js')).buildListJson;
      const { listEnvelope } = await import('../../render/json.js');
      const listed = await buildList(
        { target: 'workflows', limit: WORKFLOW_LIST_LIMIT },
        { logger: await quietLogger(), note: () => undefined },
      );
      return listEnvelope(listed.items) as ListResult;
    },
    ...(deps.activeRuns === undefined ? {} : { activeRuns: deps.activeRuns }),
  };
}

/** Registers every M1 reader on `methods`. */
export function registerReads(methods: RpcMethodRegistry, deps: ReadDeps): void {
  for (const spec of READERS) {
    const entry = findLeaf(spec.path);
    if (entry === undefined) throw new Error(`No registry leaf for ${spec.path.join(' ')}.`);
    if (spec.paged === true) {
      registerLedgerRead(methods, ledgerDeps(deps));
      continue;
    }
    if (spec.runRead === true) continue;
    methods.register(spec.method, {
      params: ReadParams,
      result: ReadResult,
      handler: (params) => {
        if (params.cursor !== undefined || params.limit !== undefined) {
          throw new RpcError(
            'invalid_params',
            `${spec.method} is not paged.`,
            'Omit cursor and limit.',
          );
        }
        return runRead(spec, entry, params, deps);
      },
    });
  }
}
