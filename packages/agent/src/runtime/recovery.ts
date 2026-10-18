import type { ArtifactScope, RunHealth } from '@yantra/protocol';

import type { FillCoverage } from './fulfillment.js';
import { renderProgressLine, type LiveItem, type ProgressCheckpoint } from './progress-ledger.js';

export const STALL_POLICY = {
  noProgressCalls: 6,
  minCallsForTime: 2,
  noProgressMs: 120_000,
} as const;
export type RecoveryTrigger =
  | { readonly kind: 'stalled'; readonly calls: number; readonly ms: number }
  | { readonly kind: 'turn-timeout'; readonly thinkingMs: number };
export interface RecoveryRung {
  readonly id: 'steer' | 'freeze' | 'stop';
  readonly entry: 'first-trigger' | 'second-trigger' | 'third-trigger-or-refusals';
  readonly refusalsAfterFreeze?: number;
}
export const RECOVERY_LADDER: readonly RecoveryRung[] = [
  { id: 'steer', entry: 'first-trigger' },
  { id: 'freeze', entry: 'second-trigger' },
  { id: 'stop', entry: 'third-trigger-or-refusals', refusalsAfterFreeze: 2 },
];

/** A successful call is not progress unless a semantic signal changed. */
export function isStalled(
  checkpoint: Pick<ProgressCheckpoint, 'noProgressCalls' | 'msSinceProgress'>,
  softReached: boolean,
): boolean {
  return (
    !softReached &&
    (checkpoint.noProgressCalls >= STALL_POLICY.noProgressCalls ||
      (checkpoint.noProgressCalls >= STALL_POLICY.minCallsForTime &&
        checkpoint.msSinceProgress >= STALL_POLICY.noProgressMs))
  );
}

/** One runner owns both trigger kinds and the complete bounded attempt ledger. */
export class RecoveryRunner {
  private index = 0;
  public constructor(
    private readonly history: NonNullable<RunHealth['progress']>['recovery'],
    private readonly rebase: () => void,
  ) {}
  public onTrigger(trigger: RecoveryTrigger): RecoveryRung | null {
    const rung = RECOVERY_LADDER[this.index];
    if (rung === undefined) return null;
    this.index += 1;
    this.history.rungs.push(rung.id);
    this.history.triggers.push(trigger.kind);
    this.rebase();
    return rung;
  }
  public onRefusalAfterFreeze(count: number): RecoveryRung | null {
    this.history.refused_after_freeze = count;
    const next = RECOVERY_LADDER[this.index];
    if (next?.id !== 'stop' || count < (next.refusalsAfterFreeze ?? Infinity)) return null;
    return this.onTrigger({ kind: 'stalled', calls: count, ms: 0 });
  }
}

export interface NextMoveState {
  readonly explorationOpen?: boolean;
  readonly items: readonly LiveItem[];
  readonly coverage: FillCoverage | null;
  readonly tools: ReadonlySet<string>;
  readonly fieldKinds: boolean;
  readonly captureScopes: readonly ArtifactScope[];
  readonly clean: (text: string) => string;
}
export interface NextMove {
  readonly id: 'fill-remaining' | 'list-fields' | 'capture' | 'publish';
  readonly tool: string;
  readonly detailKeys: readonly string[];
  applies(state: NextMoveState): boolean;
  render(state: NextMoveState): string;
}
const needsFill = (state: NextMoveState): boolean =>
  state.items.some((i) => i.kind === 'fill' && i.state !== 'met');
function captureScope(state: NextMoveState): ArtifactScope | undefined {
  return state.captureScopes.find((scope) =>
    state.items.some((i) => i.id === `artifact:screenshot:${scope}` && i.state !== 'met'),
  );
}
/** Advice vocabulary is closed and tied to registered capabilities and detail keys. */
export const NEXT_MOVES: readonly NextMove[] = [
  {
    id: 'fill-remaining',
    tool: 'browser_fill_form',
    detailKeys: ['refs'],
    applies: (s) =>
      s.explorationOpen !== false && needsFill(s) && (s.coverage?.remaining.length ?? 0) > 0,
    render: (s) =>
      `call browser_fill_form for these remaining controls (refs): ${s
        .coverage!.remaining.slice(0, 10)
        .map((c) => `${c.ref} (${s.clean(c.label).replace(/\s+/gu, ' ').trim().slice(0, 40)})`)
        .join(', ')}`,
  },
  {
    id: 'list-fields',
    tool: 'browser_observe',
    detailKeys: ['kinds'],
    applies: (s) =>
      s.explorationOpen !== false && needsFill(s) && !s.coverage?.complete && s.fieldKinds,
    render: () => 'call browser_observe with kinds: ["field"] to list the remaining fields',
  },
  {
    id: 'capture',
    tool: 'browser_capture',
    detailKeys: ['scope'],
    applies: (s) => !needsFill(s) && captureScope(s) !== undefined,
    render: (s) =>
      `call browser_capture with scope: "${captureScope(s)}" to save the requested screenshot`,
  },
  {
    id: 'publish',
    tool: 'result_publish',
    detailKeys: [],
    applies: () => true,
    render: () => 'call result_publish now and list each unmet requirement with its reason',
  },
];
export function selectNextMove(state: NextMoveState): NextMove {
  const move = NEXT_MOVES.find((m) => state.tools.has(m.tool) && m.applies(state));
  if (move === undefined) throw new Error('Recovery requires a registered publication capability');
  return move;
}
function time(ms: number | null): string {
  if (ms === null) return 'unbounded';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
/** Runtime-authored, bounded recovery message; cleaning applies after interpolation too. */
export function buildRecoveryMessage(input: {
  readonly rung: RecoveryRung['id'];
  readonly trigger: RecoveryTrigger;
  readonly state: NextMoveState;
  readonly explorationMs: number | null;
  readonly publicationMs: number | null;
}): { readonly message: string; readonly move: NextMove } {
  const move =
    input.rung === 'steer' ? selectNextMove(input.state) : NEXT_MOVES[NEXT_MOVES.length - 1]!;
  const trigger =
    input.trigger.kind === 'stalled'
      ? `no task progress in the last ${input.trigger.calls} calls (${time(input.trigger.ms)})`
      : `thinking exceeded ${time(input.trigger.thinkingMs)}`;
  const message = [
    `Progress check: ${trigger}.`,
    `Requirements: ${renderProgressLine(input.state.items) || 'no live action requirements'}.`,
    `Time: ${time(input.explorationMs)} of exploration left, then ${time(input.publicationMs)} reserved for publishing.`,
    input.rung === 'steer'
      ? `Next: ${move.render(input.state)}.`
      : 'Next: exploration is closed; call result_publish now and list each unmet requirement with its reason.',
    'If that cannot work, call result_publish now and list each unmet requirement with its reason.',
  ].join('\n');
  return { message: input.state.clean(message).slice(0, 1200), move };
}
