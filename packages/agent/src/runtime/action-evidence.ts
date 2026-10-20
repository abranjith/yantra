/** In-memory, nonserializable committed observations and value-free Brief projections. */
import type { PayloadSanitizer } from '@yantra/core';
import type { ActionId, BriefAction } from '@yantra/protocol';

import { idOf, type ActionLedgerEntry, type ActionLedger } from './action-ledger.js';

/** Private fields deliberately serialize to {}: this store must never become a run artifact. */
export class ActionObservations {
  readonly #values = new Map<ActionId, string>();
  readonly #sanitize: (text: string) => string;
  public constructor(sanitizer: PayloadSanitizer, mask: (text: string) => string = (text) => text) {
    this.#sanitize = (text) => sanitizer.sanitize(mask(text), 'public').text.slice(0, 120);
  }
  /** Store only model-visible, non-withheld text. Callers never pass a protected value. */
  public record(id: ActionId, text: string): void {
    this.#values.set(id, this.#sanitize(text));
  }
  public get(id: ActionId): string | null {
    return this.#values.get(id) ?? null;
  }
}

export interface ActionEvidenceView {
  entries(): readonly ActionLedgerEntry[];
  observed(id: ActionId): string | null;
}

export function actionEvidenceView(
  ledger: ActionLedger,
  observations: ActionObservations,
): ActionEvidenceView {
  return { entries: () => ledger.entries(), observed: (id) => observations.get(id) };
}

/** Text used only for anchoring, never persisted. Protected values cannot enter it. */
export function actionEvidenceText(entry: ActionLedgerEntry, observation: string | null): string {
  switch (entry.kind) {
    case 'fill_committed':
      return `Filled ${entry.identity?.label ?? entry.field} field ${entry.identity?.section ?? ''} ${entry.verification.withheld === null ? (observation ?? '') : ''} verified ${entry.verification.withheld?.verdict ?? entry.verification.resolution ?? ''}`
        .replace(/\s+/gu, ' ')
        .trim();
    case 'click_executed':
      return `Clicked ${entry.name}`;
    case 'submit_refused':
      return `Did not click ${entry.name}. Did not submit the form. Submit refused ${entry.signal}`;
    case 'capture':
      return `Captured the page screenshot ${entry.scope.replaceAll('_', ' ')} ${entry.parts ?? 1} parts`;
  }
}

/** Value-free public projection; it is safe to persist this, never the observation store. */
export function briefActionOf(entry: ActionLedgerEntry): BriefAction {
  const base = {
    id: idOf(entry),
    epoch: entry.epoch,
    call_id: entry.callId,
    host: entry.host || null,
  };
  switch (entry.kind) {
    case 'fill_committed': {
      const identity = entry.identity;
      const origin = identity?.origin ?? 'explicit';
      const verification =
        entry.verification.withheld !== null
          ? { withheld: entry.verification.withheld }
          : entry.verification.resolution !== null
            ? { resolution: entry.verification.resolution }
            : undefined;
      return {
        ...base,
        kind: 'fill',
        ref: entry.ref,
        label: origin === 'none' ? null : (identity?.label ?? entry.field),
        label_origin: origin,
        ...(identity?.confidence && origin !== 'explicit' && origin !== 'none'
          ? { confidence: identity.confidence }
          : {}),
        ...(identity?.section ? { section: identity.section } : {}),
        ...(verification === undefined ? {} : { verification }),
      };
    }
    case 'click_executed':
      return { ...base, kind: 'click', label: entry.name, ref: entry.ref };
    case 'submit_refused':
      return {
        ...base,
        kind: 'submit_refused',
        label: entry.name,
        signal: entry.signal,
        ...(entry.ref === null ? {} : { ref: entry.ref }),
      };
    case 'capture':
      return {
        ...base,
        kind: 'capture',
        label: null,
        ...(entry.artifacts.length > 0 ? { artifacts: [...entry.artifacts] } : {}),
      };
  }
}
