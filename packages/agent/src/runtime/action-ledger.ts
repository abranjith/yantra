/**
 * The run's action ledger (FEAT-054): what the browser tools verifiably did.
 *
 * Fulfillment is judged from this record, never from what the model says it
 * did. Producers append only verified outcomes: a fill the engine committed and
 * verified, a click that executed, a submit-class click the engine refused, and
 * a capture written to the run directory. A failed fill or click records
 * nothing.
 *
 * Each entry is stamped with the top-level committed-document epoch and host
 * at record time, so a capture can be tied to the document the last action
 * left behind. The ledger stores identities only: never a typed value, a
 * selector, or a secret reference. Field and control names pass through the
 * run's sanitizer and the user-input mask before they are kept.
 */

import type {
  Logger,
  PayloadSanitizer,
  SubmitSignal,
  LabelOrigin,
  LabelConfidence,
  FillResolution,
  WithheldCommit,
} from '@yantra/core';
import type { ArtifactScope, ArtifactRef, ActionId } from '@yantra/protocol';

import type { CaptureArtifactSet } from './capture-artifacts.js';
import type { SubmitRefusalSignal } from './submit-policy.js';

/** Longest kept field name. */
const MAX_FIELD_CHARS = 60;

/** Longest kept control name. */
const MAX_NAME_CHARS = 80;

/** Fields every entry carries, stamped by the ledger. */
interface LedgerStamp {
  readonly callId: string | null;
  /** Monotonic 1-based sequence number within the run. */
  readonly seq: number;
  /** ISO-8601 record time. */
  readonly at: string;
  /** Top-level committed-document epoch at record time, or null when unknown. */
  readonly epoch: number | null;
  /** Page host at record time, or `''` before any navigation. */
  readonly host: string;
}

/** A fill the engine committed and verified. */
export interface FillCommittedEntry extends LedgerStamp {
  readonly identity: {
    readonly label: string | null;
    readonly origin: LabelOrigin;
    readonly confidence: LabelConfidence | null;
    readonly section: string | null;
  } | null;
  readonly verification: {
    readonly resolution: FillResolution | null;
    readonly withheld: WithheldCommit | null;
  };
  readonly kind: 'fill_committed';
  readonly tool: 'browser_fill_form' | 'browser_fill_element';
  readonly ref: string;
  /** The sanitized resolved field name (≤ 60 characters). Never a value. */
  readonly field: string;
  /** The control's widget group (radio/checkbox group, paired control), or null. */
  readonly groupKey: string | null;
  /** How many caller fields this one entry stands for (2 for a fused date range). */
  readonly covers: number;
  /** Resolved controls committed together, such as both legs of a date range. */
  readonly coveredRefs?: readonly string[];
}

/** A click that executed. */
export interface ClickExecutedEntry extends LedgerStamp {
  readonly kind: 'click_executed';
  readonly ref: string;
  /** The sanitized control name (≤ 80 characters). */
  readonly name: string;
  /** Whether the target was submit-class, and by which signal. */
  readonly submitClass: SubmitSignal | null;
}

/** A submit-class action the engine refused under `effects.submit: forbidden`. */
export interface SubmitRefusedEntry extends LedgerStamp {
  readonly kind: 'submit_refused';
  /** The refused ref, or null for a refused nested workflow. */
  readonly ref: string | null;
  readonly name: string;
  readonly signal: SubmitRefusalSignal;
}

/** A capture written to the run directory. */
export interface CaptureEntry extends LedgerStamp {
  readonly artifacts: readonly ArtifactRef[];
  readonly kind: 'capture';
  readonly scope: ArtifactScope;
  /** Run-relative path of the PNG (part 1 of a tiled set). */
  readonly path: string;
  /** SHA-256 of that PNG. */
  readonly sha256: string;
  /** Bytes written, across every part. */
  readonly bytes: number;
  /** The tool that produced it. */
  readonly producer: string;
  /** How many PNG files the capture wrote (FEAT-058); 1 when absent. */
  readonly parts?: number;
  /** False when the set was clipped or truncated (FEAT-058); true when absent. */
  readonly complete?: boolean;
  /**
   * Every saved file of a `browser_capture` set, for the Brief and the
   * outcome's artifact references. Kept in memory only: never logged.
   */
  readonly captureSet?: CaptureArtifactSet;
}

/** One verified action outcome. */
export type ActionLedgerEntry =
  | FillCommittedEntry
  | ClickExecutedEntry
  | SubmitRefusedEntry
  | CaptureEntry;

/** A committed action: what a later capture must follow. */
export type CommittedActionEntry = FillCommittedEntry | ClickExecutedEntry;

/** What a producer supplies; the ledger adds the stamp. */
export type ActionLedgerInput = { readonly callId?: string | null } & (
  | (Omit<FillCommittedEntry, keyof LedgerStamp | 'identity' | 'verification'> &
      Partial<Pick<FillCommittedEntry, 'identity' | 'verification'>>)
  | Omit<ClickExecutedEntry, keyof LedgerStamp>
  | Omit<SubmitRefusedEntry, keyof LedgerStamp>
  | (Omit<CaptureEntry, keyof LedgerStamp | 'artifacts'> & Partial<Pick<CaptureEntry, 'artifacts'>>)
);

/** IDs are the existing ledger sequence, never a second counter. */
export function idOf(entry: Pick<ActionLedgerEntry, 'seq'>): ActionId {
  return `A${entry.seq}`;
}

/** Where the browser is when an entry is recorded. */
export interface LedgerLocation {
  readonly epoch: number | null;
  readonly host: string;
}

/** Construction inputs for one run's {@link ActionLedger}. */
export interface ActionLedgerOptions {
  /** ISO-8601 clock. */
  readonly nowIso: () => string;
  /** The browser's current document epoch and host, read at record time. */
  readonly locate: () => LedgerLocation;
  /** The run's sanitizer, applied to every kept name. */
  readonly sanitizer: PayloadSanitizer;
  /** Masks the user's own input values back to placeholders. */
  readonly mask?: (text: string) => string;
  /** The run's `runtime.jsonl` logger, when one exists. */
  readonly logger?: Logger;
}

/** The `action_recorded` runtime-log projection: no names, refs, or paths. */
interface ActionRecordedEvent {
  readonly schema_version: 1;
  readonly event: 'action_recorded';
  readonly kind: ActionLedgerEntry['kind'];
  readonly seq: number;
  readonly epoch: number | null;
  readonly host: string;
  readonly covers?: number;
  readonly submit_class?: SubmitSignal | null;
  readonly signal?: SubmitRefusalSignal;
  readonly scope?: ArtifactScope;
  readonly bytes?: number;
  readonly parts?: number;
  readonly complete?: boolean;
}

/** The run-scoped, append-only record of verified action outcomes. */
export class ActionLedger {
  private readonly recorded: ActionLedgerEntry[] = [];

  public constructor(private readonly options: ActionLedgerOptions) {}

  /**
   * Appends one verified outcome, stamping its sequence, time, epoch, and host.
   *
   * @returns The stored entry.
   */
  public record(input: ActionLedgerInput): ActionLedgerEntry {
    const location = this.safeLocate();
    const stamp: LedgerStamp = {
      callId: input.callId ?? null,
      seq: this.recorded.length + 1,
      at: this.options.nowIso(),
      epoch: location.epoch,
      host: location.host,
    };
    const defaults =
      input.kind === 'fill_committed'
        ? {
            identity: input.identity ?? null,
            verification: input.verification ?? { resolution: null, withheld: null },
          }
        : input.kind === 'capture'
          ? { artifacts: input.artifacts ?? [] }
          : {};
    const entry = this.cleaned({ ...input, ...defaults, ...stamp } as ActionLedgerEntry);
    this.recorded.push(entry);
    this.options.logger?.info({ ...projection(entry) }, 'action recorded');
    return entry;
  }

  /** Every entry in record order. */
  public entries(): readonly ActionLedgerEntry[] {
    return [...this.recorded];
  }

  /** The latest committed fill or click, or null when the run committed none. */
  public lastCommittedAction(): CommittedActionEntry | null {
    for (let index = this.recorded.length - 1; index >= 0; index -= 1) {
      const entry = this.recorded[index]!;
      if (entry.kind === 'fill_committed' || entry.kind === 'click_executed') return entry;
    }
    return null;
  }

  /** Captures recorded after sequence number `seq`. */
  public capturesAfter(seq: number): readonly CaptureEntry[] {
    return this.recorded.filter(
      (entry): entry is CaptureEntry => entry.kind === 'capture' && entry.seq > seq,
    );
  }

  private safeLocate(): LedgerLocation {
    try {
      return this.options.locate();
    } catch {
      // swallow-ok: a browser that cannot report its position stamps unknown, never fails the action
      return { epoch: null, host: '' };
    }
  }

  private cleaned(entry: ActionLedgerEntry): ActionLedgerEntry {
    switch (entry.kind) {
      case 'fill_committed':
        return {
          ...entry,
          field: this.clean(entry.field, MAX_FIELD_CHARS),
          identity:
            entry.identity === null
              ? null
              : {
                  ...entry.identity,
                  label:
                    entry.identity.label === null ? null : this.clean(entry.identity.label, 120),
                  section:
                    entry.identity.section === null ? null : this.clean(entry.identity.section, 60),
                },
        };
      case 'click_executed':
      case 'submit_refused':
        return { ...entry, name: this.clean(entry.name, MAX_NAME_CHARS) };
      case 'capture':
        return entry;
    }
  }

  private clean(text: string, max: number): string {
    const masked = this.options.mask?.(text) ?? text;
    const sanitized = this.options.sanitizer
      .sanitize(masked, 'public')
      .text.replace(/\s+/gu, ' ')
      .trim();
    return sanitized.length <= max ? sanitized : `${sanitized.slice(0, max - 1)}…`;
  }
}

/** The browser view a run's ledger reads its location from. */
interface LocatableController {
  topLevelDocumentEpoch?(): number | null;
  host(): string;
}

/**
 * The run's ledger, located through its browser controller (when the run has
 * one) and cleaned with its sanitizer and input vault.
 */
export function actionLedgerFor(input: {
  readonly controller: LocatableController | null;
  readonly sanitizer: PayloadSanitizer;
  readonly userInput?: { mask(text: string): string };
  readonly nowIso: () => string;
  readonly logger?: Logger;
}): ActionLedger {
  const { controller, userInput, logger } = input;
  return new ActionLedger({
    nowIso: input.nowIso,
    sanitizer: input.sanitizer,
    locate: () =>
      controller === null
        ? { epoch: null, host: '' }
        : { epoch: controller.topLevelDocumentEpoch?.() ?? null, host: controller.host() },
    ...(userInput === undefined ? {} : { mask: (text: string) => userInput.mask(text) }),
    ...(logger === undefined ? {} : { logger }),
  });
}

function projection(entry: ActionLedgerEntry): ActionRecordedEvent {
  const base = {
    schema_version: 1 as const,
    event: 'action_recorded' as const,
    kind: entry.kind,
    seq: entry.seq,
    epoch: entry.epoch,
    host: entry.host,
  };
  switch (entry.kind) {
    case 'fill_committed':
      return { ...base, covers: entry.covers };
    case 'click_executed':
      return { ...base, submit_class: entry.submitClass };
    case 'submit_refused':
      return { ...base, signal: entry.signal };
    case 'capture':
      return {
        ...base,
        scope: entry.scope,
        bytes: entry.bytes,
        ...(entry.parts === undefined ? {} : { parts: entry.parts }),
        ...(entry.complete === undefined ? {} : { complete: entry.complete }),
      };
  }
}
