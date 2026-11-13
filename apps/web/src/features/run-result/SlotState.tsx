/**
 * The states of an artifact slot that is not `ok` (FEAT-066), each with its
 * recovery: an older or unreadable Brief offers the `brief.md` viewer and the
 * `brief.html` download when the run has them; a file over its cap offers
 * "Show in folder". The page around it still renders.
 */

import type { ArtifactInventoryItem, ArtifactSlotState } from '@yantra/protocol';
import { Icon } from '@yantra/ui';
import type { ReactNode } from 'react';

import { formatBytes } from '../format.js';
import { ShowInFolder } from '../viewers/ShowInFolder.js';

import { DownloadArtifact, ViewerLink } from './artifact-links.js';

/** A slot that is not ok. */
export type NotOkSlot =
  | { readonly state: 'missing'; readonly path: string }
  | { readonly state: 'corrupt'; readonly path: string; readonly detail: string }
  | { readonly state: 'unsupported'; readonly path: string; readonly found_version: string }
  | {
      readonly state: 'too_large';
      readonly path: string;
      readonly bytes: number;
      readonly cap: number;
    }
  | { readonly state: 'denied'; readonly path: string };

export interface SlotStateProps {
  readonly slot: NotOkSlot;
  /** What the slot holds, in words: "Brief", "document", "outputs", "run health". */
  readonly label: string;
  readonly runId: string;
  /** The run's inventory, to offer only recoveries the run can serve. */
  readonly artifacts: readonly ArtifactInventoryItem[];
}

/** The one-line message of a slot state. */
export function slotMessage(slot: NotOkSlot, label: string): string {
  switch (slot.state) {
    case 'missing':
      return `No ${label} recorded for this run.`;
    case 'corrupt':
      return `The ${label} (${slot.path}) could not be read: ${slot.detail}.`;
    case 'unsupported':
      return `The ${label} (${slot.path}) was written in an older format (${slot.found_version}) that this app cannot show.`;
    case 'too_large':
      return `The ${label} (${slot.path}) is too large to show here: ${formatBytes(slot.bytes)}, over the ${formatBytes(slot.cap)} limit.`;
    case 'denied':
      return `The ${label} is not shown in the app.`;
  }
}

/** The companion files that can stand in for an unreadable document. */
function fallbacks(path: string): { markdown: string; html: string } | null {
  if (path === 'brief.json') return { markdown: 'brief.md', html: 'brief.html' };
  if (path === 'document.json') return { markdown: 'document.md', html: 'document.html' };
  return null;
}

const ICON: Readonly<Record<ArtifactSlotState, 'status.info' | 'outcome.failed'>> = {
  ok: 'status.info',
  missing: 'status.info',
  corrupt: 'outcome.failed',
  unsupported: 'status.info',
  too_large: 'status.info',
  denied: 'status.info',
};

/** See the module comment. */
export function SlotState({ slot, label, runId, artifacts }: SlotStateProps): ReactNode {
  const has = (path: string) => artifacts.some((item) => item.path === path);
  const companion = fallbacks(slot.path);
  const recoverable = slot.state === 'corrupt' || slot.state === 'unsupported';
  return (
    <div
      data-slot-state={slot.state}
      className="flex flex-col gap-2 rounded-control border border-rule bg-sunken p-4"
    >
      <p className="flex items-start gap-2 text-ink">
        <Icon name={ICON[slot.state]} size={16} className="mt-1 shrink-0 text-ink-2" />
        <span>{slotMessage(slot, label)}</span>
      </p>
      {recoverable && companion !== null ? (
        <div className="flex flex-wrap items-center gap-3">
          {has(companion.markdown) ? (
            <ViewerLink runId={runId} path={companion.markdown}>
              Open {companion.markdown}
            </ViewerLink>
          ) : null}
          {has(companion.html) ? (
            <DownloadArtifact runId={runId} path={companion.html}>
              Download {companion.html}
            </DownloadArtifact>
          ) : null}
        </div>
      ) : null}
      {slot.state === 'too_large' ? <ShowInFolder runId={runId} /> : null}
    </div>
  );
}
