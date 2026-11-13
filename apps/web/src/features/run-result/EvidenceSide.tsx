/**
 * The evidence pane of the Run result page (FEAT-066 TASK-006): renders the
 * one selected citation from {@link useEvidence}, beside the document.
 *
 * - A source opens in source mode with its quote and back-references.
 * - An action opens in action mode; an id the run did not record (or any
 *   action of an older Brief without `actions`) shows "Action evidence not
 *   recorded for this run".
 * - "Cited by" buttons scroll to and focus the citing claim.
 */

import { ActionEvidence, EvidencePane, SourceEvidence } from '@yantra/ui';
import type { ReactNode } from 'react';

import { formatTimestamp } from '../format.js';

import { evidenceKey, useEvidence } from './EvidenceProvider.js';

/** Scrolls to a claim and moves focus to it (a user action). */
export function goToClaim(targetId: string): void {
  const target = document.getElementById(targetId);
  if (target === null) return;
  target.scrollIntoView?.({ block: 'center' });
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus();
}

/** See the module comment. */
export function EvidenceSide(): ReactNode {
  const evidence = useEvidence();
  const selected = evidence.selected;
  if (selected === null) return null;
  const ref = selected.ref;
  const backReferences = evidence.index.backRefs.get(evidenceKey(ref)) ?? [];

  if (ref.kind === 'source') {
    const source = evidence.index.sources.get(ref.n);
    return (
      <EvidencePane
        heading={`Source ${String(ref.n)}`}
        onClose={evidence.close}
        backReferences={backReferences}
        onBackReference={goToClaim}
      >
        {source === undefined ? (
          <p className="text-ink-2">Source not recorded for this run</p>
        ) : (
          <SourceEvidence source={source} formatTime={formatTimestamp} />
        )}
      </EvidencePane>
    );
  }
  return (
    <EvidencePane
      heading={`Action ${ref.id}`}
      onClose={evidence.close}
      backReferences={backReferences}
      onBackReference={goToClaim}
    >
      <ActionEvidence
        action={evidence.index.actions?.get(ref.id) ?? null}
        onShowCapture={evidence.showCapture}
      />
    </EvidencePane>
  );
}
