import type { AgentInteractable } from '../browser/agent-controller.js';
import type { RawFieldEvidence } from '../discovery/interactable-scan.js';

import { normalizeText } from './types.js';

export type LabelOrigin = 'explicit' | 'structural' | 'placeholder' | 'title' | 'none';
export type LabelConfidence = 'high' | 'medium' | 'low';
export const FIELD_IDENTITY_MAX_BYTES = 256;
export const INTERACTABLE_ENTRY_MAX_BYTES = 768;
export const STRUCTURAL_LABEL_MAX_CHARS = 80;

/** Semantic identity retained privately for verified replacement and census. */
export interface FieldIdentity {
  readonly label: string | null;
  readonly origin: LabelOrigin;
  readonly confidence: LabelConfidence | null;
  readonly structuralSource: NonNullable<RawFieldEvidence['structural']>['source'] | null;
  readonly section: string | null;
  readonly inputType: string | null;
  readonly autocomplete: string | null;
  readonly required: boolean;
  readonly maxLength: number | null;
  readonly pattern: string | null;
  readonly hint: { readonly htmlName: string | null; readonly htmlId: string | null } | null;
  readonly identityKey: string;
  readonly groupKey: string | null;
}

/** Bounded public projection; hints never participate in label matching. */
export interface AgentFieldIdentity {
  label?: string;
  origin: LabelOrigin;
  confidence?: LabelConfidence;
  section?: string;
  type?: string;
  autocomplete?: string;
  required?: true;
  max_length?: number;
  pattern?: string;
  hint?: { html_name?: string; html_id?: string };
}

/** Rank observed evidence without inventing a label from developer attributes. */
export function deriveFieldIdentity(role: string, evidence: RawFieldEvidence): FieldIdentity {
  const clean = (value: string | null | undefined): string | null => {
    const text = value?.replace(/\s+/gu, ' ').trim();
    return text === undefined || text.length === 0 ? null : text;
  };
  const explicit = clean(evidence.explicit);
  const structural = clean(evidence.structural?.text);
  const placeholder = clean(evidence.placeholder) ?? clean(evidence.selectPlaceholder);
  const title = clean(evidence.title);
  const origin: LabelOrigin = explicit
    ? 'explicit'
    : structural
      ? 'structural'
      : placeholder
        ? 'placeholder'
        : title
          ? 'title'
          : 'none';
  const label = explicit ?? structural ?? placeholder ?? title;
  const section = clean(evidence.section);
  const identityKey = [
    role,
    label ? normalizeText(label) : '',
    section ? normalizeText(section) : '',
    evidence.inputType,
    evidence.autocomplete,
    evidence.htmlName,
    evidence.htmlId,
  ]
    .map((part) => encodeURIComponent(part ?? ''))
    .join('|');
  return {
    label,
    origin,
    section,
    identityKey,
    confidence:
      origin === 'explicit'
        ? 'high'
        : origin === 'structural'
          ? evidence.structural?.adjacent === false
            ? 'low'
            : 'medium'
          : origin === 'none'
            ? null
            : 'low',
    structuralSource: origin === 'structural' ? (evidence.structural?.source ?? null) : null,
    inputType: evidence.inputType,
    autocomplete: evidence.autocomplete,
    required: evidence.required,
    maxLength: evidence.maxLength,
    pattern: evidence.pattern,
    hint:
      origin === 'explicit' || origin === 'structural'
        ? null
        : { htmlName: evidence.htmlName, htmlId: evidence.htmlId },
    groupKey: evidence.radioGroup
      ? `radio:${evidence.radioGroup}`
      : evidence.checkboxSet
        ? `checkbox:${evidence.checkboxSet}`
        : null,
  };
}

/** Project useful metadata and shed optional context in the specified order. */
export function projectFieldIdentity(
  name: string,
  identity: FieldIdentity,
): AgentFieldIdentity | undefined {
  const field: AgentFieldIdentity = { origin: identity.origin };
  if (identity.label && identity.label !== name) field.label = identity.label;
  if (identity.confidence) field.confidence = identity.confidence;
  if (identity.section) field.section = identity.section;
  if (identity.inputType && identity.inputType !== 'text') field.type = identity.inputType;
  if (identity.autocomplete) field.autocomplete = identity.autocomplete;
  if (identity.required) field.required = true;
  if (identity.maxLength) field.max_length = identity.maxLength;
  if (identity.pattern) field.pattern = identity.pattern;
  if (identity.hint?.htmlName || identity.hint?.htmlId)
    field.hint = {
      ...(identity.hint.htmlName ? { html_name: identity.hint.htmlName } : {}),
      ...(identity.hint.htmlId ? { html_id: identity.hint.htmlId } : {}),
    };
  if (
    identity.origin === 'explicit' &&
    Object.keys(field).every((key) => key === 'origin' || key === 'confidence')
  )
    return undefined;
  const over = (): boolean =>
    Buffer.byteLength(JSON.stringify(field), 'utf8') > FIELD_IDENTITY_MAX_BYTES;
  if (over()) delete field.hint;
  if (over()) delete field.pattern;
  if (over()) delete field.max_length;
  if (over() && field.section) field.section = Array.from(field.section).slice(0, 24).join('');
  if (over() && field.label) field.label = Array.from(field.label).slice(0, 40).join('');
  // Character limits alone do not bound UTF-8, especially for non-Latin labels.
  while (over() && (field.section || field.label)) {
    if (field.section) {
      field.section = Array.from(field.section).slice(0, -1).join('');
      if (!field.section) delete field.section;
    } else if (field.label) {
      field.label = Array.from(field.label).slice(0, -1).join('');
      if (!field.label) delete field.label;
    }
  }
  return field;
}

/** The single vocabulary for name and contextual-label resolution. */
export function resolvableNames(entry: AgentInteractable): readonly string[] {
  const label = entry.field?.label ?? (entry.field?.origin !== 'none' ? entry.name : '');
  const section = entry.field?.section ?? entry.group;
  return [
    ...new Set(
      [entry.name, label, section && label ? `${section} ${label}` : ''].filter(
        (value): value is string => Boolean(value?.trim()),
      ),
    ),
  ];
}
