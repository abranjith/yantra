/**
 * The command a finished run was started with, for Run again (FEAT-067
 * TASK-013).
 *
 * Sources, best first; each fails on its own and nothing here throws:
 *
 * 1. `execution-receipt.json` (FEAT-072) → `receipt`: the command path and
 *    working directory, the flags the user set (`argv`), and every effective
 *    non-default setting pinned as a flag (`pinnedArgv`) — only where the
 *    registry has that option for the command, never an app-only or dead one.
 * 2. The manifest → `reconstructed`: the command and its operand (a
 *    workflow's name and params, or a pipeline run's query), no flags.
 * 3. The run's `goal_echo` → `goal_only`: the goal as the run received it,
 *    when it was not redacted or cut short.
 *
 * The receipt records settings, not the operand, so the operand always comes
 * from (2) or (3). Every rebuilt command must parse with the registry parser,
 * or it falls to the next source.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  COMMAND_REGISTRY,
  ExecutionReceiptSchema,
  expandOptions,
  findLeaf,
  isAbsoluteCwd,
  isAppExemptOption,
  isKnownDeadOption,
  parseInvocation,
  type ExecutionReceipt,
  type JsonValue,
  type LeafEntry,
  type OptionSpec,
  type ReceiptSetting,
} from '@yantra/protocol';

import { readCommittedEvents } from '../run-channel/event-source.js';

/** Where the prior command came from. */
export type PriorSource = 'receipt' | 'reconstructed' | 'goal_only';

/** The rebuilt prior command, or why there is none. */
export interface PriorInvocation {
  readonly prior: PriorSource | null;
  /** Command path, e.g. `['research']`. */
  readonly path: readonly string[] | null;
  /** The operand and the flags the user set: "current settings" re-resolve the rest now. */
  readonly argv: readonly string[] | null;
  /** The operand and every effective non-default setting as a flag: "prior settings". */
  readonly pinnedArgv: readonly string[] | null;
  /** The absolute working directory it ran in, when recorded. */
  readonly cwd: string | null;
  /** Artifacts that could not be read, in words (each failed on its own). */
  readonly notices: readonly string[];
}

const NONE: PriorInvocation = {
  prior: null,
  path: null,
  argv: null,
  pinnedArgv: null,
  cwd: null,
  notices: [],
};

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

/** The flag tokens for one setting, or none when it cannot be a flag. */
export function settingFlag(spec: OptionSpec, value: JsonValue): string[] {
  if (spec.value === 'none') {
    const present = spec.negatable ? value === false : value === true;
    return present ? [spec.long] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      typeof item === 'string' || typeof item === 'number' ? [spec.long, String(item)] : [],
    );
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [spec.long, String(value)];
  }
  return [];
}

/** Flags for `settings` the registry has for `entry`, keeping those `keep` accepts. */
function flagsFor(
  entry: LeafEntry,
  settings: readonly ReceiptSetting[],
  keep: (setting: ReceiptSetting) => boolean,
): string[] {
  const specs = expandOptions(entry, COMMAND_REGISTRY.option_groups);
  const out: string[] = [];
  for (const setting of settings) {
    if (!keep(setting)) continue;
    const spec = specs.find((option) => option.attribute === setting.key);
    if (spec === undefined || spec.input.kind === 'secret-input') continue;
    if (isAppExemptOption(spec.long) || isKnownDeadOption(entry.id, spec.long)) continue;
    // Run params come with the operand from the manifest.
    if (entry.id === 'run' && spec.long === '--params') continue;
    out.push(...settingFlag(spec, setting.value));
  }
  return out;
}

/** The operand (and run params) from the manifest, by its shape. */
async function manifestOperand(
  runDir: string,
): Promise<{ path: string[]; operand: string[] } | null> {
  const raw = (await readJson(join(runDir, 'manifest.json'))) as Record<string, unknown>;
  if (raw === null || typeof raw !== 'object') return null;
  const type = raw.type;
  if ((type === 'ask' || type === 'research' || type === 'do') && typeof raw.query === 'string') {
    return { path: [type], operand: [raw.query] };
  }
  const workflowName = raw.workflowName;
  if (typeof workflowName !== 'string' || workflowName === '') return null;
  if (raw.runKind === 'agentic') return { path: [workflowName], operand: [] };
  const params =
    raw.params !== null && typeof raw.params === 'object'
      ? Object.entries(raw.params as Record<string, unknown>).flatMap(([key, value]) =>
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? ['--params', `${key}=${String(value)}`]
            : [],
        )
      : [];
  return { path: ['run'], operand: [workflowName, ...params] };
}

/** The goal as the run received it, when it was shown in full. */
async function echoedGoal(runDir: string): Promise<string | null> {
  try {
    for await (const committed of readCommittedEvents(runDir, 1)) {
      const event = committed.event as { kind?: unknown; display?: unknown; truncated?: unknown };
      if (event.kind !== 'goal_echo') continue;
      if (event.truncated === true || typeof event.display !== 'string') return null;
      const match = /^goal: "(.*)"$/su.exec(event.display);
      return match?.[1] ?? null;
    }
  } catch {
    // No event log: no goal.
  }
  return null;
}

/** An operand placed so it stays an operand, as the composer does. */
function withOperand(operand: readonly string[], flags: readonly string[]): string[] {
  const [first, ...rest] = operand;
  if (first === undefined) return [...flags];
  return first.startsWith('-') ? [...rest, ...flags, '--', first] : [first, ...rest, ...flags];
}

function parses(path: readonly string[], argv: readonly string[], cwd: string): boolean {
  return parseInvocation([...path, ...argv], { cwd }).isOk;
}

/** See the module comment. */
export async function recoverPriorInvocation(runDir: string): Promise<PriorInvocation> {
  const notices: string[] = [];
  let receipt: ExecutionReceipt | null = null;
  try {
    const parsed = ExecutionReceiptSchema.safeParse(
      await readJson(join(runDir, 'execution-receipt.json')),
    );
    if (parsed.success) receipt = parsed.data;
    else notices.push('execution-receipt.json is not a valid receipt.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      notices.push('execution-receipt.json could not be read.');
    }
  }

  let fromManifest: { path: string[]; operand: string[] } | null = null;
  try {
    fromManifest = await manifestOperand(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      notices.push('manifest.json could not be read.');
    }
  }
  const goal = await echoedGoal(runDir);
  const path = receipt?.command ?? fromManifest?.path ?? null;
  const entry = path === null ? undefined : findLeaf(path);
  if (path === null || entry === undefined) return { ...NONE, notices };

  const operand =
    fromManifest !== null && fromManifest.operand.length > 0
      ? fromManifest.operand
      : goal === null
        ? []
        : [goal];
  const cwd = receipt?.cwd ?? null;
  const parseCwd = cwd !== null && isAbsoluteCwd(cwd) ? cwd : '/';
  const required = entry.arguments.some((argument) => argument.required);
  if (required && operand.length === 0) return { ...NONE, notices };

  if (receipt !== null) {
    const argv = withOperand(
      operand,
      flagsFor(entry, receipt.settings, (s) => s.source.kind === 'flag'),
    );
    const pinnedArgv = withOperand(
      operand,
      flagsFor(entry, receipt.settings, (s) => s.source.kind !== 'default'),
    );
    if (parses(path, argv, parseCwd) && parses(path, pinnedArgv, parseCwd)) {
      return { prior: 'receipt', path, argv, pinnedArgv, cwd, notices };
    }
    notices.push('The recorded settings no longer parse; only the command was rebuilt.');
  }
  const bare = withOperand(operand, []);
  if (!parses(path, bare, parseCwd)) return { ...NONE, notices };
  const prior: PriorSource =
    fromManifest !== null && fromManifest.operand.length > 0 ? 'reconstructed' : 'goal_only';
  return { prior, path, argv: bare, pinnedArgv: bare, cwd, notices };
}
