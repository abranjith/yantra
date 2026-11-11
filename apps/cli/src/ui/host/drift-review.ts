/**
 * Queue drift review (FEAT-065 TASK-017, plan D13).
 *
 * Before a queued item reserves a slot, its effective settings are resolved
 * again, read-only, through the FEAT-072 settings resolver: the command's own
 * registry binding runs with a handler that only drafts the execution
 * receipt, so the same precedence chain the worker will use answers, and
 * nothing executes. Workflow and template content identities are re-hashed.
 *
 * Only what the composer showed (`displayed_effective`) is compared. Any
 * difference moves the item to `needs_review`; `queue.resolve_review` then
 * starts it with the current values, pins the submitted values as explicit
 * flags (only when every difference is a flag of this command and no content
 * changed), or discards it.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';

import type { FileInvocationStore } from '@yantra/core';
import {
  COMMAND_REGISTRY,
  expandOptions,
  jsonEqual,
  parseInvocation,
  type DisplayedEffective,
  type DriftDifference,
  type InvocationRecord,
  type JsonValue,
  type LeafEntry,
  type ReceiptSetting,
} from '@yantra/protocol';
import { z } from 'zod';

import { createTerminalContext } from '../../adapters/terminal/terminal-adapter.js';
import { executeCommand } from '../../execute.js';

import { RpcError, type RpcMethodRegistry } from './rpc-server.js';

/** What the current environment resolves an invocation to. */
export interface CurrentEffective {
  readonly settings: readonly ReceiptSetting[];
  /** Content path → its SHA-256 now, or null when the file is gone. */
  readonly content: ReadonlyMap<string, string | null>;
}

/** Resolves current effective values for a record (injected in tests). */
export type EffectiveResolver = (record: InvocationRecord) => Promise<CurrentEffective>;

const DISCARD = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

async function sha256(path: string): Promise<string | null> {
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch {
    return null;
  }
}

/** The production resolver; see the module comment. */
export function settingsResolver(env: Readonly<NodeJS.ProcessEnv>): EffectiveResolver {
  return async (record) => {
    const { invocation } = record;
    const parsed = parseInvocation([...invocation.path, ...invocation.argv], {
      cwd: invocation.cwd,
      invocationId: invocation.invocation_id,
    });
    const content = new Map<string, string | null>();
    for (const item of record.displayed_effective.content)
      content.set(item.path, await sha256(item.path));
    if (!parsed.isOk) return { settings: [], content };
    let settings: readonly ReceiptSetting[] = [];
    const context = createTerminalContext({
      env: { ...env },
      cwd: invocation.cwd,
      isTty: false,
      stdout: DISCARD,
      stderr: DISCARD,
    });
    await executeCommand(
      [...invocation.path, ...invocation.argv],
      context,
      { runStartSweep: null },
      {
        [parsed.value.entry.id]: async (_args, _options, _command, bound) => {
          settings = (await (bound ?? context).settings.draftReceipt(invocation.path)).settings;
        },
      },
    );
    return { settings, content };
  };
}

/** The env-variable name standing in for an env-sourced value: names only, never values. */
function shown(setting: ReceiptSetting | undefined): JsonValue | null {
  if (setting === undefined) return null;
  return setting.source.kind === 'env' ? `$${setting.source.name}` : setting.value;
}

function pinnable(entry: LeafEntry | undefined, key: string, submitted: JsonValue): boolean {
  if (entry === undefined) return false;
  const option = expandOptions(entry, COMMAND_REGISTRY.option_groups).find(
    (spec) => spec.attribute === key,
  );
  if (option === undefined || option.input.kind === 'secret-input') return false;
  if (option.value === 'none')
    return typeof submitted === 'boolean' && (submitted || option.negatable);
  return submitted !== null && typeof submitted !== 'object';
}

/** Compares what the composer showed with what holds now. */
export function compareEffective(
  record: InvocationRecord,
  current: CurrentEffective,
): DriftDifference[] {
  const { invocation } = record;
  const parsed = parseInvocation([...invocation.path, ...invocation.argv], {
    cwd: invocation.cwd,
    invocationId: invocation.invocation_id,
  });
  const entry = parsed.isOk ? parsed.value.entry : undefined;
  const now = new Map(current.settings.map((setting) => [setting.key, setting]));
  const differences: DriftDifference[] = [];
  for (const submitted of record.displayed_effective.settings) {
    const latest = now.get(submitted.key);
    if (latest !== undefined && jsonEqual(latest.value, submitted.value)) continue;
    differences.push({
      key: submitted.key,
      submitted: shown(submitted),
      current: shown(latest),
      pinnable: submitted.source.kind !== 'env' && pinnable(entry, submitted.key, submitted.value),
    });
  }
  for (const item of record.displayed_effective.content) {
    const latest = current.content.get(item.path) ?? null;
    if (latest === item.sha256) continue;
    differences.push({
      key: `content:${item.path}`,
      submitted: item.sha256,
      current: latest,
      pinnable: false,
    });
  }
  return differences;
}

/** Builds the supervisor's drift hook. */
export function driftReview(resolve: EffectiveResolver) {
  return async (record: InvocationRecord): Promise<DriftDifference[]> => {
    const shownSomething =
      record.displayed_effective.settings.length > 0 ||
      record.displayed_effective.content.length > 0;
    return shownSomething ? compareEffective(record, await resolve(record)) : [];
  };
}

/** The argv with each submitted value pinned as an explicit flag (appended, so it wins). */
export function pinSubmitted(record: InvocationRecord): string[] {
  const entry = parseInvocation([...record.invocation.path, ...record.invocation.argv], {
    cwd: record.invocation.cwd,
    invocationId: record.invocation.invocation_id,
  });
  const specs = entry.isOk ? expandOptions(entry.value.entry, COMMAND_REGISTRY.option_groups) : [];
  const argv = [...record.invocation.argv];
  for (const difference of record.review?.differences ?? []) {
    const spec = specs.find((option) => option.attribute === difference.key);
    const submitted = record.displayed_effective.settings.find(
      (s) => s.key === difference.key,
    )?.value;
    if (spec === undefined || submitted === undefined) continue;
    if (spec.value === 'none') {
      argv.push(submitted === true ? spec.long : spec.long.replace(/^--/u, '--no-'));
    } else if (
      typeof submitted === 'string' ||
      typeof submitted === 'number' ||
      typeof submitted === 'boolean'
    ) {
      // Only scalars are pinnable (see `pinnable`); anything else is left alone.
      argv.push(spec.long, String(submitted));
    }
  }
  return argv;
}

const ResolveReviewParams = z
  .object({
    invocation_id: z.string().min(1),
    choice: z.enum(['current', 'submitted', 'discard']),
  })
  .strict();

/** Registers `queue.resolve_review`; `dequeue` runs after a requeue. */
export function registerDriftReview(
  methods: RpcMethodRegistry,
  deps: {
    readonly store: FileInvocationStore;
    readonly resolve: EffectiveResolver;
    readonly after: (record: InvocationRecord) => Promise<Record<string, unknown>>;
  },
): void {
  methods.register('queue.resolve_review', {
    params: ResolveReviewParams,
    result: z.record(z.unknown()),
    handler: async ({ invocation_id: id, choice }) => {
      const record = await deps.store.get(id);
      if (record === null) throw new RpcError('not_found', `There is no queued item ${id}.`);
      if (record.state !== 'needs_review') {
        throw new RpcError('not_allowed', `This item is ${record.state}, not waiting for review.`);
      }
      if (choice === 'discard') return deps.after(await deps.store.discard(id));
      if (choice === 'current') {
        const current = await deps.resolve(record);
        const shownKeys = new Set(record.displayed_effective.settings.map((s) => s.key));
        const baseline: DisplayedEffective = {
          settings: current.settings.filter((s) => shownKeys.has(s.key)),
          content: record.displayed_effective.content.flatMap((item) => {
            const sha = current.content.get(item.path) ?? null;
            return sha === null ? [] : [{ ...item, sha256: sha }];
          }),
        };
        return deps.after(await deps.store.requeue(id, { displayedEffective: baseline }));
      }
      const blocked = (record.review?.differences ?? []).find((difference) => !difference.pinnable);
      if (blocked !== undefined) {
        throw new RpcError(
          'not_allowed',
          blocked.key.startsWith('content:')
            ? `${blocked.key.slice('content:'.length)} changed since it was queued, so the submitted version cannot be restored.`
            : `${blocked.key} cannot be pinned as a flag of this command.`,
          'Start it with the current values, or discard it.',
        );
      }
      return deps.after(await deps.store.requeue(id, { argv: pinSubmitted(record) }));
    },
  });
}
