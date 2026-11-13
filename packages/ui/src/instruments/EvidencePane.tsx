import type { BriefSource } from '@yantra/protocol';
import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Button } from '../primitives/Button.js';
import { Link } from '../primitives/Link.js';

/**
 * EvidencePane (FEAT-066): the evidence behind one citation, in a persistent
 * side region (`<aside>` with an accessible name), never a modal.
 *
 * - Opening it (a user's chip press) moves focus to its heading; Escape or
 *   Close calls `onClose`, which returns focus to the chip.
 * - It shows one item at a time; a new selection replaces it.
 * - Source mode: number, title, host, URL and final URL, fetch and publish
 *   times, cited or consulted, the recorded excerpt as the quote (or "Quote
 *   not recorded for this run"), and "Cited by" back-references.
 * - Action mode is {@link ActionEvidence}, rendered as `children`.
 */

/** A claim citing the evidence; pressing it scrolls to the claim. */
export interface EvidenceBackReference {
  readonly targetId: string;
  readonly label: string;
}

export interface EvidencePaneProps {
  readonly heading: string;
  readonly onClose: () => void;
  readonly backReferences?: readonly EvidenceBackReference[];
  readonly onBackReference?: (targetId: string) => void;
  readonly children: ReactNode;
  readonly className?: string;
}

/** The pane frame; see the module comment. */
export function EvidencePane({
  heading,
  onClose,
  backReferences = [],
  onBackReference,
  children,
  className,
}: EvidencePaneProps): ReactNode {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [heading]);

  return (
    <aside
      aria-label="Evidence"
      data-part="evidence-pane"
      className={cn(
        'flex flex-col gap-3 rounded-control border border-rule bg-surface p-4',
        className,
      )}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-ink outline-none">
          {heading}
        </h2>
        <Button
          variant="quiet"
          size="sm"
          icon="action.close"
          aria-label="Close evidence"
          onPress={onClose}
        />
      </div>
      {children}
      {backReferences.length === 0 ? null : (
        <section aria-label="Cited by" className="flex flex-col gap-1">
          <h3 className="type-label text-ink-2">Cited by</h3>
          <ul className="flex flex-col gap-1">
            {backReferences.map((reference) => (
              <li key={reference.targetId}>
                <Button
                  variant="quiet"
                  size="sm"
                  className="h-auto min-h-8 whitespace-normal text-start"
                  onPress={() => onBackReference?.(reference.targetId)}
                >
                  {reference.label}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

function Field({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="type-label text-ink-2">{term}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

export interface SourceEvidenceProps {
  readonly source: BriefSource;
  /** Formats an ISO time for display; defaults to the raw text. */
  readonly formatTime?: (iso: string) => string;
}

/** The source mode of the pane. */
export function SourceEvidence({
  source,
  formatTime = (iso) => iso,
}: SourceEvidenceProps): ReactNode {
  return (
    <div className="flex flex-col gap-3" data-evidence="source" data-source-n={source.n}>
      <dl className="flex flex-col gap-2">
        <Field term="Title">{source.title ?? 'No title recorded'}</Field>
        <Field term="Host">{source.host}</Field>
        <Field term="URL">
          <Link href={source.url}>{source.url}</Link>
        </Field>
        {source.final_url === null || source.final_url === source.url ? null : (
          <Field term="Final URL">
            <Link href={source.final_url}>{source.final_url}</Link>
          </Field>
        )}
        <Field term="Fetched">{formatTime(source.fetched_at)}</Field>
        <Field term="Published">
          {source.published_at === null ? 'Not recorded' : formatTime(source.published_at)}
        </Field>
        <Field term="Used as">{source.cited === false ? 'consulted, not cited' : 'cited'}</Field>
      </dl>
      {source.excerpt === null ? (
        <p data-part="quote-missing" className="text-ink-2">
          Quote not recorded for this run
        </p>
      ) : (
        <blockquote data-part="quote" className="border-s-2 border-rule-strong ps-3 text-ink">
          {source.excerpt}
        </blockquote>
      )}
    </div>
  );
}
