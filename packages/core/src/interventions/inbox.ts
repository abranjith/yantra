import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  InboxDismissal,
  InboxItem,
  type InboxItem as InboxItemType,
  type Intervention,
} from '@yantra/protocol';

import { dataDir } from '../browser/paths.js';
import { readLease } from '../run-ownership/lease-store.js';

import { InterventionLog } from './intervention-log.js';

export interface InboxOptions {
  readonly runsRoot?: string;
  readonly runDirs?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly dismissals?: readonly string[];
}

export interface InboxPage {
  readonly items: readonly InboxItemType[];
  readonly nextCursor: string | null;
  readonly count: number;
}

/** Builds a bounded, fail-soft Inbox view from run intervention logs. */
export async function buildInbox(options: InboxOptions = {}): Promise<InboxPage> {
  const root = options.runsRoot ?? join(dataDir(), 'runs');
  const runDirs = options.runDirs ?? (await discoverRunDirs(root));
  const dismissed = new Set(options.dismissals ?? (await readDismissals()));
  const all: InboxItemType[] = [];

  for (const runDir of runDirs.slice(0, 200)) {
    const runId = basename(runDir);
    const entries = await new InterventionLog(join(runDir, 'interventions.jsonl')).readAll();
    const lease = await readLease(runDir).catch(() => ({ kind: 'absent' as const }));
    const raised = new Map<string, Intervention>();
    for (const entry of entries) {
      if (entry.entry === 'raised')
        raised.set(entry.intervention.intervention_id, entry.intervention);
    }
    for (const entry of entries) {
      if (entry.entry === 'resolved') {
        if (entry.decision.decision !== 'denied' && entry.decision.decision !== 'timed_out')
          continue;
        const prior = raised.get(entry.intervention_id);
        if (prior?.kind === 'consent') {
          all.push(expiredItem({ ...prior, state: entry.decision.decision }));
        }
        continue;
      }
      if (entry.entry !== 'raised') continue;
      const intervention = entry.intervention;
      if (intervention.kind === 'consent' && intervention.state === 'pending') {
        all.push(consentItem(runId, intervention, lease.kind === 'lease'));
      } else if (
        intervention.kind !== 'consent' &&
        dismissed.has(`intervention:${intervention.intervention_id}`)
      ) {
        continue;
      } else if (intervention.kind !== 'consent') {
        all.push(informationalItem(intervention));
      }
    }
  }

  all.sort((left, right) => {
    const liveRank = (item: InboxItemType): number =>
      item.kind === 'consent_live' ? 0 : item.kind === 'consent_parked' ? 1 : 2;
    const rank = liveRank(left) - liveRank(right);
    if (rank !== 0) return rank;
    return Date.parse(right.raised_at) - Date.parse(left.raised_at);
  });

  const start =
    options.cursor === null || options.cursor === undefined ? 0 : Number(options.cursor);
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const items = all.slice(
    Number.isFinite(start) ? start : 0,
    (Number.isFinite(start) ? start : 0) + limit,
  );
  const next = (Number.isFinite(start) ? start : 0) + items.length;
  return { items, nextCursor: next < all.length ? String(next) : null, count: all.length };
}

function consentItem(runId: string, intervention: Intervention, live: boolean): InboxItemType {
  const request = intervention.request;
  const unreadable = request === null;
  const title = unreadable
    ? 'Unreadable consent request'
    : `Confirm ${request?.action_kind ?? 'action'} on ${request?.host ?? 'unknown host'}`;
  return InboxItem.parse({
    item_id: `intervention:${intervention.intervention_id}`,
    kind: live ? 'consent_live' : 'consent_parked',
    run_id: runId,
    invocation_id: null,
    title,
    raised_at: intervention.raised_at,
    intervention,
    recovery: intervention.recovery === 'resume' ? 'resume' : 'none',
    dismissible: false,
  });
}

function expiredItem(intervention: Intervention): InboxItemType {
  return InboxItem.parse({
    item_id: `intervention:${intervention.intervention_id}`,
    kind: 'expired',
    run_id: intervention.run_id,
    invocation_id: null,
    title: intervention.state === 'denied' ? 'Confirmation denied' : 'Confirmation expired',
    raised_at: intervention.raised_at,
    intervention,
    recovery: intervention.recovery === 'resume' ? 'resume' : 'run_again',
    dismissible: true,
  });
}

function informationalItem(intervention: Intervention): InboxItemType {
  const kind =
    intervention.kind === 'handoff'
      ? 'handoff'
      : intervention.kind === 'input'
        ? 'input'
        : 'expired';
  return InboxItem.parse({
    item_id: `intervention:${intervention.intervention_id}`,
    kind,
    run_id: intervention.run_id,
    invocation_id: null,
    title:
      kind === 'handoff'
        ? 'Run needs your attention'
        : kind === 'input'
          ? 'Run needs more input'
          : 'Confirmation expired',
    raised_at: intervention.raised_at,
    intervention,
    recovery:
      kind === 'input'
        ? 'run_again_with_input'
        : intervention.recovery === 'resume'
          ? 'resume'
          : 'run_again',
    dismissible: true,
  });
}

async function discoverRunDirs(root: string): Promise<string[]> {
  try {
    const names = await readdir(root);
    const dirs: { path: string; mtime: number }[] = [];
    for (const name of names) {
      const path = join(root, name);
      try {
        const info = await stat(path);
        if (info.isDirectory()) dirs.push({ path, mtime: info.mtimeMs });
      } catch {
        // One broken run directory must not break the page.
      }
    }
    return dirs.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.path);
  } catch {
    return [];
  }
}

async function readDismissals(): Promise<string[]> {
  try {
    const raw = await readFile(join(dataDir(), 'ui', 'inbox-dismissed.jsonl'), 'utf8');
    return raw.split('\n').flatMap((line) => {
      const parsed = InboxDismissal.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data.item_id] : [];
    });
  } catch {
    return [];
  }
}
