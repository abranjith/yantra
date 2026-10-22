import { canonicalUrl, type FillCensus } from '@yantra/core';
import { artifactRequirementId, type RunHealth, type TaskContractBody } from '@yantra/protocol';

import type { ActionLedger, ActionLedgerEntry } from './action-ledger.js';
import type { NowMs } from './budget.js';
import {
  actionsStatus,
  artifactCaptures,
  artifactStatus,
  censusFillEvaluator,
  fillCoverage,
  listedFillCoverage,
  submitStatus,
} from './fulfillment.js';
import { artifactLabel, type EffectiveActionTerms } from './task-contract.js';

export type ProgressSignal =
  | 'new_document'
  | 'new_page'
  | 'action_verified'
  | 'artifact_saved'
  | 'item_advanced';
export interface LiveItem {
  readonly id: string;
  readonly kind: 'fill' | 'artifact' | 'effects' | 'deliverable';
  readonly label: string;
  readonly state: 'pending' | 'advancing' | 'met';
  readonly done: number | null;
  readonly total: number | null;
}
export interface ProgressSources {
  documentCount(): number;
  page(): { readonly epoch: number | null; readonly url: string } | null;
  readonly ledger: ActionLedger;
  census(): FillCensus | null;
  terms(): EffectiveActionTerms;
  contract(): TaskContractBody | null;
}
export interface ProgressCheckpoint {
  readonly advanced: boolean;
  readonly signals: ProgressSignal[];
  readonly changedItems: LiveItem[];
  readonly noProgressCalls: number;
  readonly msSinceProgress: number;
}
type ProgressSummary = NonNullable<RunHealth['progress']>;
const RANK = { pending: 0, advancing: 1, met: 2 } as const;

/** One run's semantic progress. Every source is in memory; measurement never reads a page. */
export class ProgressLedger {
  private documents = 0;
  private readonly urls = new Set<string>();
  private verifiedSeq = 0;
  private items: readonly LiveItem[] = [];
  private lastProgressAt: number;
  private countedCalls = 0;
  private noProgressCalls = 0;
  private longestMs = 0;
  private readonly captureExemptions = new Set<string>();
  /** What verified actions have reached so far; see {@link claimCoverage}. */
  private readonly coverage = new Set<string>();
  private progressError = false;
  private readonly signals: Record<ProgressSignal, number> = {
    new_document: 0,
    new_page: 0,
    action_verified: 0,
    artifact_saved: 0,
    item_advanced: 0,
  };
  public readonly recovery: ProgressSummary['recovery'] = {
    rungs: [],
    triggers: [],
    refused_after_freeze: 0,
    steer_idle: 0,
  };
  public readonly turns: ProgressSummary['turns'] = {
    count: 0,
    with_timing: 0,
    thinking_ms_total: 0,
    thinking_ms_max: 0,
    provider_ms_total: 0,
    reasoning_tokens: null,
    turn_limit_aborts: 0,
  };

  public constructor(
    public readonly sources: ProgressSources,
    private readonly now: NowMs,
    private mode: 'enforce' | 'observe',
  ) {
    this.lastProgressAt = now();
  }

  /** Diff a completed counted call against the last snapshot. Bookkeeping is neutral. */
  public checkpoint(boundary: {
    readonly tool: string;
    readonly role: 'counted' | 'bookkeeping';
    readonly at?: string;
  }): ProgressCheckpoint {
    if (boundary.role === 'bookkeeping') {
      const items = this.liveItems();
      const changedItems = this.changedItems(items);
      this.items = items;
      return {
        advanced: false,
        signals: [],
        changedItems,
        noProgressCalls: this.noProgressCalls,
        msSinceProgress: Math.max(0, this.now() - this.lastProgressAt),
      };
    }
    const now = this.now();
    const signals: ProgressSignal[] = [];
    const documents = this.sources.documentCount();
    if (documents > this.documents) signals.push('new_document');
    const page = this.sources.page();
    if (page !== null && page.url.length > 0) {
      const url = canonicalUrl(page.url);
      if (!this.urls.has(url)) {
        this.urls.add(url);
        signals.push('new_page');
      }
    }
    const entries = this.sources.ledger
      .entries()
      .filter((e) => e.kind !== 'submit_refused' && e.seq > this.verifiedSeq);
    // Only an action that reaches something not reached before is progress: a
    // re-fill of a committed field, a repeat click, or an identical capture is
    // a successful no-op and must not reset the stall window (REV-004).
    const fresh = entries.filter((e) => this.claimCoverage(e));
    if (fresh.length > 0) signals.push('action_verified');
    if (fresh.some((e) => e.kind === 'capture')) signals.push('artifact_saved');
    const items = this.liveItems();
    const changedItems = this.changedItems(items);
    if (
      items.some((item) => {
        const previous = this.items.find((p) => p.id === item.id);
        return previous !== undefined
          ? RANK[item.state] > RANK[previous.state] || (item.done ?? 0) > (previous.done ?? 0)
          : (item.done ?? 0) > 0 || (item.state === 'met' && item.kind !== 'effects');
      })
    )
      signals.push('item_advanced');
    this.longestMs = Math.max(this.longestMs, now - this.lastProgressAt);
    this.countedCalls += 1;
    this.documents = documents;
    this.verifiedSeq = Math.max(this.verifiedSeq, ...entries.map((e) => e.seq));
    this.items = items;
    for (const signal of signals) this.signals[signal] += 1;
    if (signals.length > 0) {
      this.noProgressCalls = 0;
      this.lastProgressAt = now;
    } else this.noProgressCalls += 1;
    return {
      advanced: signals.length > 0,
      signals,
      changedItems,
      noProgressCalls: this.noProgressCalls,
      msSinceProgress: Math.max(0, now - this.lastProgressAt),
    };
  }

  /**
   * Records what one verified action reached and reports whether any of it
   * is new: a field or widget group per document, a control per document, or
   * a capture's content. Keys hold refs, epochs, scopes, and hashes only.
   */
  private claimCoverage(entry: ActionLedgerEntry): boolean {
    const keys: string[] = [];
    switch (entry.kind) {
      case 'submit_refused':
        return false;
      case 'fill_committed':
        keys.push(`fill|${entry.epoch}|${entry.groupKey ?? `ref:${entry.ref}`}`);
        for (const ref of entry.coveredRefs ?? []) keys.push(`fill|${entry.epoch}|ref:${ref}`);
        break;
      case 'click_executed':
        keys.push(`click|${entry.epoch}|${entry.ref}`);
        break;
      case 'capture':
        keys.push(`capture|${entry.scope}|${entry.sha256}`);
        break;
    }
    const fresh = keys.filter((key) => !this.coverage.has(key));
    for (const key of fresh) this.coverage.add(key);
    return fresh.length > 0;
  }

  /** Rebase after a rung so every later stall requires a fresh no-progress window. */
  public rebase(): void {
    this.noProgressCalls = 0;
    this.lastProgressAt = this.now();
  }
  private changedItems(items: readonly LiveItem[]): LiveItem[] {
    return items.filter((item) => {
      const previous = this.items.find((p) => p.id === item.id);
      return (
        previous?.state !== item.state ||
        previous.done !== item.done ||
        previous.total !== item.total
      );
    });
  }
  public failOpen(): void {
    this.mode = 'observe';
    this.progressError = true;
  }
  public enforcing(): boolean {
    return this.mode === 'enforce';
  }
  public unmetArtifactCount(): number {
    return this.liveItems().filter((i) => i.kind === 'artifact' && i.state !== 'met').length;
  }
  public exemptCapturesUsed(): number {
    return this.captureExemptions.size;
  }
  /** Only a declared, still-unmet scope can reserve one late capture attempt. */
  public captureExemptionAvailable(scope: unknown): boolean {
    return this.captureExemptionItems(scope).length > 0;
  }
  public reserveExemptCapture(scope: unknown): void {
    for (const item of this.captureExemptionItems(scope)) this.captureExemptions.add(item.id);
  }
  private captureExemptionItems(scope: unknown): LiveItem[] {
    return this.liveItems().filter(
      (item) =>
        item.kind === 'artifact' &&
        item.state !== 'met' &&
        !this.captureExemptions.has(item.id) &&
        (item.id === `artifact:screenshot:${String(scope)}` ||
          (scope === 'full_page' && item.id === 'artifact:screenshot:viewport')),
    );
  }

  /** Derive live items through the same evaluators publication uses. */
  public liveItems(): LiveItem[] {
    const terms = this.sources.terms();
    const entries = this.sources.ledger.entries();
    const items: LiveItem[] = [];
    const add = (
      id: string,
      kind: LiveItem['kind'],
      label: string,
      status: string,
      related: boolean,
      done: number | null = null,
      total: number | null = null,
    ): void => {
      items.push({
        id,
        kind,
        label: label.slice(0, 60),
        state: status === 'met' ? 'met' : related ? 'advancing' : 'pending',
        done,
        total,
      });
    };
    const census = this.sources.census();
    if (terms.fill !== null) {
      const coverage =
        terms.fill.coverage === 'listed'
          ? listedFillCoverage(terms.fill.fields, entries)
          : census === null
            ? null
            : fillCoverage(census, entries);
      const result = censusFillEvaluator(census)(terms.fill, entries);
      add(
        'fill',
        'fill',
        'fields',
        result.status,
        (coverage?.filled ?? 0) > 0,
        coverage?.filled ?? null,
        coverage?.eligible ?? null,
      );
    }
    for (const artifact of terms.artifacts) {
      const result = artifactStatus(artifact.scope, { ledger: entries, captureGap: () => null });
      add(
        artifactRequirementId(artifact.scope),
        'artifact',
        artifactLabel(artifact.scope),
        result.status,
        artifactCaptures(artifact.scope, entries).length > 0,
      );
    }
    if (terms.submit.value === 'forbidden')
      add(
        'effects.submit',
        'effects',
        'do not submit',
        submitStatus(entries).status,
        entries.some(
          (e) =>
            e.kind === 'submit_refused' || (e.kind === 'click_executed' && e.submitClass !== null),
        ),
      );
    const contract = this.sources.contract();
    if (contract?.deliverable === 'actions')
      add(
        'deliverable',
        'deliverable',
        'actions',
        actionsStatus(entries, contract).status,
        entries.some((e) => e.kind === 'fill_committed' || e.kind === 'click_executed'),
      );
    return items;
  }

  /** Counts and closed codes only. Uses the last checkpoint, safe after browser teardown. */
  public summary(): ProgressSummary {
    const fill = this.items.find((i) => i.kind === 'fill');
    return {
      mode: this.mode,
      ...(this.progressError ? { progress_error: true } : {}),
      items: this.items.slice(0, 6).map(({ kind, state }) => ({ kind, state })),
      fill:
        fill?.done !== null && fill?.done !== undefined && fill.total !== null
          ? { done: fill.done, total: fill.total }
          : null,
      signals: { ...this.signals },
      counted_calls: this.countedCalls,
      no_progress_calls: this.noProgressCalls,
      longest_no_progress_ms: Math.max(0, Math.round(this.longestMs)),
      recovery: {
        ...this.recovery,
        rungs: [...this.recovery.rungs],
        triggers: [...this.recovery.triggers],
      },
      turns: { ...this.turns },
    };
  }
}

/** Bounded terminal line, with ASCII punctuation and at most three items. */
export function renderProgressLine(items: readonly LiveItem[]): string {
  const phrases = items
    .slice(0, 3)
    .map((item) =>
      item.kind === 'fill'
        ? item.done === null
          ? 'fields pending'
          : `fields ${item.done}/${item.total}`
        : `${item.label} ${item.kind === 'effects' && item.state === 'met' ? 'held' : item.state === 'met' ? 'met' : 'pending'}`,
    );
  if (items.length > 3) phrases.push(`+${items.length - 3} more`);
  return phrases.join('; ').slice(0, 160);
}
