/**
 * Generated provider schema for one report-template manifest.
 *
 * The schema is generated instead of hand-written so structural deviation is
 * unrepresentable to the provider: every model-owned slot is required with its
 * declared value shape, unknown keys are closed, and reserved `sources` never
 * enters model input. A slot's enclosing heading path is its description source
 * because arbitrary slot keys alone carry no reliable semantics for the model.
 */

import type { TemplateManifest, TemplateSlot } from '@yantra/protocol';
import { Type, type TObject, type TProperties } from 'typebox';

/**
 * Build the closed `result_publish` parameter schema for a template manifest.
 *
 * @param manifest Active parsed template.
 * @returns A TypeBox object with one closed `report` object of model-owned slots.
 */
export function templateParamsFor(manifest: TemplateManifest): TObject {
  const properties: TProperties = {};
  for (const slot of manifest.slots) {
    if (slot.kind === 'sources') continue;
    const description = slotDescription(slot);
    switch (slot.kind) {
      case 'text':
      case 'markdown':
        properties[slot.key] = Type.String({ minLength: 1, description });
        break;
      case 'list':
        properties[slot.key] = Type.Array(Type.String(), {
          description,
          ...(slot.constraints.min === undefined ? {} : { minItems: slot.constraints.min }),
          ...(slot.constraints.max === undefined ? {} : { maxItems: slot.constraints.max }),
        });
        break;
      case 'table':
        properties[slot.key] = Type.Array(Type.Array(Type.String()), {
          description,
          ...(slot.constraints.min === undefined ? {} : { minItems: slot.constraints.min }),
          ...(slot.constraints.max === undefined ? {} : { maxItems: slot.constraints.max }),
        });
        break;
    }
  }
  return Type.Object(
    {
      report: Type.Object(properties, {
        additionalProperties: false,
        description: reportDescription(manifest),
      }),
    },
    { additionalProperties: false },
  );
}

function slotDescription(slot: TemplateSlot): string {
  const details: string[] = [];
  if (slot.key === 'title') {
    // The canonical title heading becomes empty after placeholder removal, so
    // title uses a stable prefix and deliberately skips the heading sentence.
    details.push('Document title. Required.');
  } else {
    const heading = slot.headingPath.length > 0 ? slot.headingPath.join(' > ') : slot.key;
    details.push(`Content for "${heading}".`);
  }
  switch (slot.kind) {
    case 'text':
      details.push('Plain text.');
      break;
    case 'markdown':
      details.push('Markdown prose.');
      break;
    case 'list':
      details.push('Array of short plain-text items.');
      break;
    case 'table':
      details.push(
        `Rows of exactly ${slot.columns?.length ?? 0} cells: ${slot.columns?.join(', ') ?? ''}.`,
      );
      break;
    case 'sources':
      break;
  }
  const { minChars, maxChars, minWords, maxWords, min, max } = slot.constraints;
  if (minChars !== undefined) details.push(`At least ${minChars} characters.`);
  if (maxChars !== undefined) details.push(`At most ${maxChars} characters.`);
  if (minWords !== undefined) details.push(`At least ${minWords} words.`);
  if (maxWords !== undefined) details.push(`At most ${maxWords} words.`);
  if (min !== undefined)
    details.push(`At least ${min} ${slot.kind === 'table' ? 'rows' : 'items'}.`);
  if (max !== undefined)
    details.push(`At most ${max} ${slot.kind === 'table' ? 'rows' : 'items'}.`);
  // Guidance goes last so the stable structural and constraint prefix remains scannable.
  if (slot.guidance !== null) details.push(slot.guidance);
  return details.join(' ');
}

/**
 * Build the enclosing report-object description with optional document guidance.
 *
 * @param manifest Active parsed template.
 * @returns Stable rendering contract followed by author guidance when present.
 */
function reportDescription(manifest: TemplateManifest): string {
  const description =
    'Values for the active report template. Yantra renders the surrounding document.';
  return manifest.guidance === null ? description : `${description} ${manifest.guidance}`;
}
