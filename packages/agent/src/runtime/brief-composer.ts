/** Run-owned attribution: resolve evidence IDs before numbering protocol sources. */
import type { DocumentStore, PayloadSanitizer } from '@yantra/core';
import { err, ok, type BriefNotice, type Result, type TaskContractBody } from '@yantra/protocol';

import { INLINE_EVIDENCE_REF, parseEvidenceRef } from './evidence-refs.js';
import type { EvidenceEntry } from './run-services.js';

export type ComposeCause =
  | 'reference-unknown'
  | 'reference-anchor-unknown'
  | 'reference-numeric'
  | 'row-uncited'
  | 'row-width'
  | 'row-sources-length'
  | 'contract-table-missing'
  | 'contract-field-missing';
export interface ComposeIssue {
  readonly cause: ComposeCause;
  readonly pointer: string;
  readonly values: Record<string, string>;
}
export interface ResolvedRef {
  readonly ref: string;
  readonly sourceId: string;
  readonly anchor: number | null;
  readonly entryIndex: number;
}
export interface ComposeSummary {
  readonly cited_sources: number;
  readonly consulted_sources: number;
  readonly table_rows: number;
  readonly alternatives_rows: number;
  readonly alternatives_findings: number;
  readonly constraints: {
    readonly verified: number;
    readonly unverified: number;
    readonly violated: number;
  };
  readonly contract_gaps: number;
  readonly claims_checked: number;
  readonly flagged: number;
}
export interface ComposedBrief {
  readonly content: Record<string, unknown>;
  readonly notices: readonly BriefNotice[];
  readonly verdict: {
    readonly claims_checked: number;
    readonly flagged: number;
    readonly stripped: 0;
  };
  readonly summary: ComposeSummary;
}
export interface AgentPublishContent {
  readonly title: string;
  readonly overview: string;
  readonly key_findings: readonly (
    | string
    | { readonly text: string; readonly sources?: readonly string[] }
  )[];
  readonly sections?: readonly {
    readonly heading: string;
    readonly body_md: string;
    readonly sources?: readonly string[];
  }[];
}
export interface ComposeContext {
  readonly evidence: readonly EvidenceEntry[];
  readonly documents: DocumentStore;
  readonly contract: TaskContractBody | null;
  readonly mode: 'tool' | 'assembled';
}
interface CitedText {
  text: string;
  refs: string[];
  pointer: string;
}
interface CitedSection {
  heading: string;
  body_md: string;
  refs: string[];
  pointer: string;
}

// Keep line breaks only in paragraph fields; strip C0/C1 bytes everywhere else.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu;
export function publishText(value: unknown, max: number, multiline = false): string {
  return (typeof value === 'string' ? value : '')
    .replace(CONTROLS, '')
    .replace(multiline ? /\r/gu : /[\r\n]/gu, ' ')
    .trim()
    .slice(0, max);
}
export function asPublishRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function publishArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
const refsFrom = (value: unknown): string[] =>
  publishArray(value)
    .slice(0, 8)
    .filter((ref): ref is string => typeof ref === 'string');
const union = (refs: readonly string[]): string[] => [...new Set(refs)];

/** Public-sanitize all model-authored strings before composition and validation. */
export function sanitizePublishContent(raw: unknown, sanitizer: PayloadSanitizer): unknown {
  if (typeof raw === 'string') return sanitizer.sanitize(raw, 'public').text;
  if (Array.isArray(raw)) return raw.map((value) => sanitizePublishContent(value, sanitizer));
  if (raw !== null && typeof raw === 'object')
    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [key, sanitizePublishContent(value, sanitizer)]),
    );
  return raw;
}

/** Compose agent content without I/O; all references resolve against this run alone. */
export function composeAgentBrief(
  input: unknown,
  ctx: ComposeContext,
): Result<ComposedBrief, ComposeIssue[]> {
  const raw = asPublishRecord(input);
  const issues: ComposeIssue[] = [];
  const evidence = ctx.evidence.filter(
    (entry, i, all) =>
      entry.sourceId === null ||
      all.findIndex((candidate) => candidate.sourceId === entry.sourceId) === i,
  );
  const byId = new Map(
    evidence.flatMap((entry, index) =>
      entry.sourceId === null ? [] : [[entry.sourceId, index] as const],
    ),
  );
  const resolved = new Map<string, ResolvedRef>();
  const known = knownSources([...byId.keys()]);
  const resolve = (ref: string, pointer: string): boolean => {
    const parsed = parseEvidenceRef(ref);
    const entryIndex = parsed === null ? undefined : byId.get(parsed.sourceId);
    if (parsed === null || entryIndex === undefined) {
      issues.push({ cause: 'reference-unknown', pointer, values: { ref, pointer, known } });
      return false;
    }
    if (parsed.anchor !== null && ctx.documents.resolveAnchor(ref) === null) {
      issues.push({
        cause: 'reference-anchor-unknown',
        pointer,
        values: { ref, pointer, source: parsed.sourceId },
      });
      return false;
    }
    resolved.set(ref, { ref, ...parsed, entryIndex });
    return true;
  };
  const textRefs = (text: string, explicit: string[], pointer: string): CitedText => {
    const refs = explicit.filter((ref, index) => resolve(ref, `${pointer}/sources/${index}`));
    let cleaned = text.replace(/\[\d+\]/gu, (marker) => {
      if (ctx.mode === 'tool')
        issues.push({ cause: 'reference-numeric', pointer, values: { pointer } });
      return ctx.mode === 'assembled' ? '' : marker;
    });
    cleaned = cleaned.replace(INLINE_EVIDENCE_REF, (marker, ref: string) => {
      if (resolve(ref, pointer)) {
        refs.push(ref);
        return marker;
      }
      return ctx.mode === 'assembled' ? '' : marker;
    });
    return { text: cleaned, refs: union(refs), pointer };
  };
  const overview = textRefs(publishText(raw.overview, 20000, true), [], 'overview');
  const findings = publishArray(raw.key_findings)
    .slice(0, 20)
    .map((value, index) => {
      const finding = asPublishRecord(value);
      return textRefs(
        publishText(typeof value === 'string' ? value : finding.text, 4000),
        refsFrom(finding.sources),
        `key_findings/${index}`,
      );
    })
    .filter((finding) => finding.text.length > 0);
  const sections: CitedSection[] = publishArray(raw.sections)
    .slice(0, 8)
    .map((value, index) => {
      const section = asPublishRecord(value);
      const body = textRefs(
        publishText(section.body_md, 4000, true),
        refsFrom(section.sources),
        `sections/${index}`,
      );
      return {
        heading: publishText(section.heading, 120),
        body_md: body.text,
        refs: body.refs,
        pointer: body.pointer,
      };
    });
  const blocking =
    ctx.mode === 'assembled'
      ? issues.filter((issue) => !issue.cause.startsWith('reference-'))
      : issues;
  if (blocking.length > 0) return err(blocking);
  const citedIds = union(
    [overview, ...findings, ...sections].flatMap((item) =>
      item.refs.map((ref) => resolved.get(ref)!.sourceId),
    ),
  );
  const order = [
    ...citedIds.map((id) => byId.get(id)!),
    ...evidence.map((_, i) => i).filter((i) => !citedIds.includes(evidence[i]!.sourceId ?? '')),
  ];
  const numbers = new Map(order.map((entryIndex, i) => [entryIndex, i + 1]));
  const citations = (refs: readonly string[]): number[] =>
    union(refs.map((ref) => resolved.get(ref)!.sourceId)).map((id) => numbers.get(byId.get(id)!)!);
  const rewrite = (text: string): string =>
    text.replace(
      INLINE_EVIDENCE_REF,
      (_, ref: string) => `[${numbers.get(resolved.get(ref)!.entryIndex)}]`,
    );
  const sources =
    evidence.length === 0
      ? publishArray(raw.sources)
      : order.map((i) => {
          const entry = evidence[i]!;
          const date = (value: string | null): string | null =>
            value === null || Number.isNaN(Date.parse(value))
              ? null
              : new Date(value).toISOString();
          let finalUrl: string | null = null;
          try {
            if (entry.finalUrl !== null) {
              new URL(entry.finalUrl);
              finalUrl = entry.finalUrl;
            }
          } catch {
            /* swallow-ok: invalid redirect provenance is omitted */
          }
          return {
            url: entry.url,
            final_url: finalUrl,
            title: entry.title,
            excerpt: entry.excerpt,
            fetched_at: date(entry.fetchedAt) ?? undefined,
            published_at: date(entry.publishedAt),
            cited: citedIds.includes(entry.sourceId ?? ''),
          };
        });
  return ok({
    content: {
      title: publishText(raw.title, 200),
      overview: rewrite(overview.text),
      key_findings: findings.map((finding) => ({
        text: rewrite(finding.text),
        citations: citations(finding.refs),
        editorial: finding.refs.length === 0,
      })),
      sections: sections.map((section) => ({
        heading: section.heading,
        body_md: rewrite(section.body_md),
        citations: citations(section.refs),
      })),
      facets: null,
      sources,
    },
    notices: [],
    verdict: { claims_checked: 0, flagged: 0, stripped: 0 },
    summary: {
      cited_sources: citedIds.length,
      consulted_sources: evidence.length - citedIds.length,
      table_rows: 0,
      alternatives_rows: 0,
      alternatives_findings: 0,
      constraints: { verified: 0, unverified: 0, violated: 0 },
      contract_gaps: 0,
      claims_checked: 0,
      flagged: 0,
    },
  });
}

function knownSources(ids: readonly string[]): string {
  const values = ids.map((id) => Number(id.slice(1))).sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const start = values[i]!;
    let end = start;
    while (values[i + 1] === end + 1) {
      i += 1;
      end = values[i]!;
    }
    ranges.push(start === end ? `S${start}` : `S${start}–S${end}`);
  }
  return (ranges.join(', ') || '(none)').slice(0, 120);
}
