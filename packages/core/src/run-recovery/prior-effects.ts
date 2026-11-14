/**
 * What a finished run may have changed on websites, for the Run again
 * warning (FEAT-067 TASK-013).
 *
 * - `verified`: the Brief cites verified `fill` or `click` actions, or a
 *   workflow step with `submit: true` completed.
 * - `possible`: the contract allowed submitting a form and no verified action
 *   was recorded, or the command can reach websites (`external`) and the run
 *   recorded no evidence at all (a legacy or early-failed run).
 * - `none`: otherwise.
 *
 * Each verdict carries plain reasons. Every artifact is read on its own: a
 * missing or corrupt file counts as no evidence from it, and nothing here
 * throws.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readCommittedEvents } from '../run-channel/event-source.js';

/** The verdict. */
export type PriorEffects = 'none' | 'possible' | 'verified';

/** The verdict and why. */
export interface PriorEffectsAssessment {
  readonly effects: PriorEffects;
  readonly reasons: readonly string[];
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
}

/** Verified actions in the Brief, by kind and host. */
function briefActions(brief: unknown): { fills: number; clicks: number; hosts: string[] } | null {
  if (brief === null || typeof brief !== 'object') return null;
  const actions = (brief as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return { fills: 0, clicks: 0, hosts: [] };
  let fills = 0;
  let clicks = 0;
  const hosts = new Set<string>();
  for (const action of actions as unknown[]) {
    if (action === null || typeof action !== 'object') continue;
    const { kind, host } = action as { kind?: unknown; host?: unknown };
    if (kind !== 'fill' && kind !== 'click') continue;
    if (kind === 'fill') fills += 1;
    else clicks += 1;
    if (typeof host === 'string' && host !== '') hosts.add(host);
  }
  return { fills, clicks, hosts: [...hosts] };
}

/**
 * Whether the latest contract revision allowed submitting a form. Only this
 * one field is read, so a contract from an older or newer writer still
 * answers (a whole-schema parse would drop the signal).
 */
function submitAllowed(contract: unknown): boolean {
  const revisions = (contract as { revisions?: unknown } | null | undefined)?.revisions;
  if (!Array.isArray(revisions)) return false;
  const latest = revisions.at(-1) as { contract?: { effects?: { submit?: unknown } } } | undefined;
  return latest?.contract?.effects?.submit === 'allowed';
}

/** Steps of the plan that submit a form. */
function submittingSteps(plan: unknown): string[] {
  const steps = (plan as { steps?: unknown } | undefined)?.steps;
  if (!Array.isArray(steps)) return [];
  return (steps as unknown[]).flatMap((step) => {
    const { id, submit } = (step ?? {}) as { id?: unknown; submit?: unknown };
    return submit === true && typeof id === 'string' ? [id] : [];
  });
}

/** Step ids the run recorded as completed. */
async function completedSteps(runDir: string): Promise<{ steps: Set<string>; anyEvent: boolean }> {
  const steps = new Set<string>();
  let anyEvent = false;
  try {
    for await (const committed of readCommittedEvents(runDir, 1)) {
      anyEvent = true;
      const event = committed.event as { kind?: unknown; step_id?: unknown };
      if (event.kind === 'step_completed' && typeof event.step_id === 'string')
        steps.add(event.step_id);
    }
  } catch {
    // No event log: no completed steps from it.
  }
  return { steps, anyEvent };
}

/** See the module comment. */
export async function assessPriorEffects(
  runDir: string,
  commandEffect: 'none' | 'local' | 'external',
): Promise<PriorEffectsAssessment> {
  const brief = await readJson(join(runDir, 'brief.json'));
  const contract = await readJson(join(runDir, 'contract.json'));
  const plan = await readJson(join(runDir, 'plan.json'));
  const { steps: completed, anyEvent } = await completedSteps(runDir);

  const verified: string[] = [];
  const actions = briefActions(brief);
  if (actions !== null && (actions.fills > 0 || actions.clicks > 0)) {
    const parts = [
      ...(actions.fills > 0 ? [`filled ${plural(actions.fills, 'field')}`] : []),
      ...(actions.clicks > 0 ? [`clicked ${plural(actions.clicks, 'control')}`] : []),
    ];
    const where = actions.hosts.length === 0 ? '' : ` on ${actions.hosts.join(', ')}`;
    verified.push(`The previous run ${parts.join(' and ')}${where}.`);
  }
  const submitted = submittingSteps(plan).filter((id) => completed.has(id));
  if (submitted.length > 0) {
    verified.push(`The workflow submitted a form (step ${submitted.join(', ')}).`);
  }
  const allowed = submitAllowed(contract);

  if (verified.length > 0) {
    return {
      effects: 'verified',
      reasons: allowed ? [...verified, 'It was allowed to submit a form.'] : verified,
    };
  }
  if (allowed) {
    return {
      effects: 'possible',
      reasons: ['The previous run was allowed to submit a form, and no action was recorded.'],
    };
  }
  const evidence = actions !== null || (plan !== null && typeof plan === 'object') || anyEvent;
  if (commandEffect === 'external' && !evidence) {
    return {
      effects: 'possible',
      reasons: [
        'The previous run recorded no evidence of what it did on websites, so it may have changed something.',
      ],
    };
  }
  return { effects: 'none', reasons: [] };
}
