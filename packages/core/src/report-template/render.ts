/** Deterministic Markdown renderer for validated template slot values. */

import type {
  BriefSource,
  TemplateManifest,
  TemplateSlot,
  TemplateSlotValue,
} from '@yantra/protocol';

/**
 * Substitute validated values into a manifest body at the parser-recorded offsets.
 *
 * Replacements run from the end of the body toward the start, so earlier slot
 * offsets remain stable regardless of generated content length.
 *
 * @param manifest Parsed template manifest.
 * @param slots Model-filled values (the reserved sources value is ignored).
 * @param sources Engine-owned evidence ledger sources.
 * @returns Canonical rendered Markdown without adding a trailing newline.
 */
export function renderTemplate(
  manifest: TemplateManifest,
  slots: Readonly<Record<string, TemplateSlotValue>>,
  sources: readonly BriefSource[],
): string {
  let rendered = manifest.body;
  for (const slot of [...manifest.slots].sort((left, right) => right.offset - left.offset)) {
    const close = rendered.indexOf('}}', slot.offset);
    if (close < 0) continue;
    const replacement =
      slot.kind === 'sources' ? renderSources(sources) : renderSlot(slot, slots[slot.key]);
    rendered = `${rendered.slice(0, slot.offset)}${replacement}${rendered.slice(close + 2)}`;
  }
  return rendered.replace(/\r\n/gu, '\n').replace(/\n+$/u, '');
}

function renderSlot(slot: TemplateSlot, value: TemplateSlotValue | undefined): string {
  switch (slot.kind) {
    case 'text':
    case 'markdown':
      return typeof value === 'string' ? value : '';
    case 'list':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? value.map((entry) => `- ${entry}`).join('\n')
        : '';
    case 'table': {
      const columns = slot.columns ?? [];
      const rows = Array.isArray(value) && value.every((row) => Array.isArray(row)) ? value : [];
      const header = `| ${columns.map(escapeTableCell).join(' | ')} |`;
      const separator = `| ${columns.map(() => '---').join(' | ')} |`;
      const body = rows.map(
        (row) => `| ${row.map((cell) => escapeTableCell(String(cell))).join(' | ')} |`,
      );
      return [header, separator, ...body].join('\n');
    }
    case 'sources':
      return '';
  }
}

function renderSources(sources: readonly BriefSource[]): string {
  if (sources.length === 0) return '_No sources were consulted._';
  return sources
    .map((source) => {
      const label = escapeLinkLabel(source.title ?? source.host);
      return `${source.n}. [${label}](${source.url})`;
    })
    .join('\n');
}

function escapeTableCell(value: string): string {
  return value.replace(/\r?\n/gu, '<br>').replace(/\|/gu, '\\|');
}

function escapeLinkLabel(value: string): string {
  return value.replace(/(\\|\[|\])/gu, '\\$1').replace(/\r?\n/gu, ' ');
}
