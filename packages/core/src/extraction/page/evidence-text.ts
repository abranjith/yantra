/** Evidence corpora are runtime-only, bounded text; never model-visible. */
import type { PageAnalysis, PageRecord } from './types.js';

/** All checkable record values, preserving label/value context. */
export function recordEvidenceText(record: PageRecord): string {
  return [
    record.title ?? '',
    ...record.segments,
    ...record.fields.map((field) => `${field.label}: ${field.value}`),
    ...record.numbers.map((number) => number.text),
    ...record.links.map((link) => link.text),
  ].join('\n');
}
/** Page prose, records, fields, tables and structured scalar values (≤200k chars). */
export function pageEvidenceText(page: PageAnalysis, title: string | null): string {
  const pieces = [
    title ?? '',
    page.readableText,
    ...page.records.map(recordEvidenceText),
    ...page.fields.map((field) => `${field.label}: ${field.value}`),
    ...page.tables.flatMap((table) => [
      table.caption ?? '',
      ...table.headers,
      ...table.rows.flat(),
    ]),
    ...page.structured.flatMap((entity) => Object.values(entity.props).map(String)),
  ];
  return pieces.join('\n').slice(0, 200000);
}
