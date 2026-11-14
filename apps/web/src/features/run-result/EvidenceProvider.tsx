/**
 * The citation context of one document (FEAT-066 TASK-005/006).
 *
 * Built from the Brief (or templated report): `n → source`, `A<n> → action`,
 * and the back-references from each piece of evidence to the claims that cite
 * it (findings, child findings, sections, comparison rows, conditions). It
 * also holds the one selected piece of evidence the EvidencePane shows.
 *
 * Source tokens become chips only when the source exists. Action tokens in a
 * Brief always become chips: one whose id does not resolve (or any `A<n>` in
 * an older Brief without `actions`) opens "Action evidence not recorded for
 * this run" in the pane, never a dead chip.
 */

import type { Brief, BriefAction, BriefSource } from '@yantra/protocol';
import { CitationChip, type CitationContext, type CitationRef } from '@yantra/ui';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** A claim that cites a piece of evidence, with the element id to scroll to. */
export interface BackReference {
  readonly targetId: string;
  readonly label: string;
}

/** The evidence lookup of one document. */
export interface EvidenceIndex {
  readonly sources: ReadonlyMap<number, BriefSource>;
  /** Null when the document records no action evidence (older Briefs, documents). */
  readonly actions: ReadonlyMap<string, BriefAction> | null;
  /** Whether `A<n>` tokens are chips at all (Briefs only). */
  readonly actionTokens: boolean;
  /** `S<n>` or `A<n>` → the claims citing it. */
  readonly backRefs: ReadonlyMap<string, readonly BackReference[]>;
}

/** The element ids the document gives its claims, shared with back-references. */
export const claimId = {
  finding: (index: number) => `finding-${String(index + 1)}`,
  child: (index: number, child: number) => `finding-${String(index + 1)}-${String(child + 1)}`,
  section: (index: number) => `section-${String(index + 1)}`,
  row: (index: number) => `comparison-row-${String(index + 1)}`,
  condition: (index: number) => `condition-${String(index + 1)}`,
} as const;

/** The key of a piece of evidence in {@link EvidenceIndex.backRefs}. */
export function evidenceKey(ref: CitationRef): string {
  return ref.kind === 'source' ? `S${String(ref.n)}` : ref.id;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/** Builds the lookup maps and back-references of a Brief. */
export function indexBrief(brief: Brief): EvidenceIndex {
  const backRefs = new Map<string, BackReference[]>();
  const add = (key: string, ref: BackReference): void => {
    const list = backRefs.get(key) ?? [];
    if (!list.some((item) => item.targetId === ref.targetId)) list.push(ref);
    backRefs.set(key, list);
  };
  const cite = (
    citations: readonly number[] | undefined,
    actions: readonly string[] | undefined,
    ref: BackReference,
  ): void => {
    for (const n of citations ?? []) add(`S${String(n)}`, ref);
    for (const id of actions ?? []) add(id, ref);
  };

  brief.key_findings.forEach((finding, index) => {
    cite(finding.citations, finding.actions, {
      targetId: claimId.finding(index),
      label: `Finding ${String(index + 1)}: ${excerpt(finding.text)}`,
    });
    finding.children.forEach((child, childIndex) => {
      cite(child.citations, undefined, {
        targetId: claimId.child(index, childIndex),
        label: `Finding ${String(index + 1)}.${String(childIndex + 1)}: ${excerpt(child.text)}`,
      });
    });
  });
  brief.sections.forEach((section, index) => {
    cite(section.citations, section.actions, {
      targetId: claimId.section(index),
      label: `Section: ${excerpt(section.heading)}`,
    });
  });
  const comparison = brief.facets?.comparison ?? null;
  comparison?.rows.forEach((row, index) => {
    cite(comparison.row_citations?.[index], comparison.row_actions?.[index], {
      targetId: claimId.row(index),
      label: `Comparison row ${String(index + 1)}: ${excerpt(String(row[0] ?? ''))}`,
    });
  });
  brief.constraints?.forEach((constraint, index) => {
    cite(constraint.citations, undefined, {
      targetId: claimId.condition(index),
      label: `Condition: ${constraint.name}`,
    });
  });

  return {
    sources: new Map(brief.sources.map((source) => [source.n, source])),
    actions:
      brief.actions === undefined
        ? null
        : new Map(brief.actions.map((action) => [action.id, action])),
    actionTokens: true,
    backRefs,
  };
}

/** The lookup of a templated report: sources only. */
export function indexSources(sources: readonly BriefSource[]): EvidenceIndex {
  return {
    sources: new Map(sources.map((source) => [source.n, source])),
    actions: null,
    actionTokens: false,
    backRefs: new Map(),
  };
}

/** The tooltip preview of a chip. */
export function previewOf(index: EvidenceIndex, ref: CitationRef): string {
  if (ref.kind === 'source') {
    const source = index.sources.get(ref.n);
    return source === undefined ? '' : `${source.host} — ${source.title ?? source.url}`;
  }
  const action = index.actions?.get(ref.id);
  return action === undefined
    ? 'Action evidence not recorded for this run'
    : `${action.kind}${action.label === null ? '' : ` — ${action.label}`}`;
}

interface Selection {
  readonly ref: CitationRef;
  /** The chip that opened the pane, so Close returns focus to it. */
  readonly origin: HTMLElement | null;
}

interface EvidenceContextValue {
  readonly index: EvidenceIndex;
  readonly selected: Selection | null;
  readonly select: (ref: CitationRef, origin: HTMLElement | null) => void;
  readonly close: () => void;
  /** The capture file an action's capture link asked the gallery to show. */
  readonly selectedCapture: string | null;
  readonly showCapture: (path: string) => void;
  readonly citations: CitationContext;
  /** Chips for a citation list and action list, in that order. */
  readonly chips: (
    citations: readonly number[] | undefined,
    actions?: readonly string[],
  ) => ReactNode;
}

const EvidenceContext = createContext<EvidenceContextValue | null>(null);

/** Provides one document's citation context; see the module comment. */
export function EvidenceProvider({
  index,
  children,
}: {
  readonly index: EvidenceIndex;
  readonly children: ReactNode;
}): ReactNode {
  const [selected, setSelected] = useState<Selection | null>(null);
  const [selectedCapture, setSelectedCapture] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const select = useCallback((ref: CitationRef, origin: HTMLElement | null) => {
    setSelected({ ref, origin });
  }, []);

  const close = useCallback(() => {
    const origin = selectedRef.current?.origin ?? null;
    setSelected(null);
    // Focus returns to the chip that opened the pane (a user action).
    if (origin?.isConnected === true) origin.focus();
  }, []);

  // The chips and the citation context depend only on the document, never on
  // the selection: a selection change must not remount the chips, or focus
  // could not return to the one that opened the pane.
  const stable = useMemo(() => {
    const chip = (ref: CitationRef): ReactNode => (
      <CitationChip
        key={evidenceKey(ref)}
        kind={ref.kind}
        id={ref.kind === 'source' ? String(ref.n) : ref.id}
        preview={previewOf(index, ref)}
        onPress={(element) => {
          select(ref, element);
        }}
      />
    );
    const citations: CitationContext = {
      resolves: (ref) => (ref.kind === 'source' ? index.sources.has(ref.n) : index.actionTokens),
      render: chip,
    };
    const chips = (
      sourceNumbers: readonly number[] | undefined,
      actionIds?: readonly string[],
    ): ReactNode => (
      <>
        {(sourceNumbers ?? [])
          .filter((n) => index.sources.has(n))
          .map((n) => chip({ kind: 'source', n }))}
        {index.actionTokens ? (actionIds ?? []).map((id) => chip({ kind: 'action', id })) : null}
      </>
    );
    const showCapture = (path: string): void => {
      setSelectedCapture(path);
      document.querySelector(`[data-capture="${CSS.escape(path)}"]`)?.scrollIntoView?.({
        block: 'nearest',
      });
    };
    return { citations, chips, showCapture };
  }, [index, select]);

  const value = useMemo<EvidenceContextValue>(
    () => ({ index, selected, select, close, selectedCapture, ...stable }),
    [index, selected, select, close, selectedCapture, stable],
  );

  return <EvidenceContext.Provider value={value}>{children}</EvidenceContext.Provider>;
}

/** The document's citation context; throws outside {@link EvidenceProvider}. */
export function useEvidence(): EvidenceContextValue {
  const value = useContext(EvidenceContext);
  if (value === null) throw new Error('useEvidence() needs an <EvidenceProvider> above it.');
  return value;
}
