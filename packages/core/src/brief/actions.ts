/** Shared action wording, emitted as structured text and capture links. */
import type { Brief, BriefAction } from '@yantra/protocol';

export type ActionPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'artifact'; readonly path: string; readonly label: string };

// eslint-disable-next-line no-control-regex -- never forward raw page control bytes into a renderer
const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim();

/** Plain text pieces are escaped by each renderer; only artifact pieces can become links. */
export function actionParts(
  action: BriefAction,
  brief: Pick<Brief, 'artifacts'>,
): readonly ActionPart[] {
  const parts: ActionPart[] = [];
  let description: string;
  switch (action.kind) {
    case 'fill': {
      const origin = action.label_origin ?? 'explicit';
      const qualifier =
        origin === 'structural'
          ? 'page layout'
          : origin === 'placeholder'
            ? 'placeholder text'
            : origin === 'title'
              ? 'title text'
              : null;
      description =
        origin === 'none'
          ? `filled field ${action.ref ?? '?'} (no label found)`
          : `filled "${clean(action.label ?? '')}"`;
      if (qualifier !== null)
        description += ` (label inferred from ${qualifier}${action.confidence === undefined ? '' : `, ${action.confidence} confidence`})`;
      if (action.section !== undefined) description += ` in "${clean(action.section)}"`;
      if (action.verification !== undefined)
        description +=
          'resolution' in action.verification
            ? `; verified ${action.verification.resolution}`
            : `; verified ${action.verification.withheld.verdict} (value withheld)`;
      break;
    }
    case 'click':
      description = `clicked "${clean(action.label ?? '')}"`;
      break;
    case 'submit_refused':
      description = `did not click "${clean(action.label ?? '')}" (submit refused: it would submit the form)`;
      break;
    case 'capture': {
      const refs = action.artifacts ?? [];
      const scope = brief.artifacts?.find((artifact) => artifact.path === refs[0]?.path)?.scope;
      description = `captured ${scope === undefined ? '' : `${scope.replaceAll('_', '-')} `}screenshot`;
      if (refs.length > 0) description += refs.length > 1 ? `, ${refs.length} parts: ` : ': ';
      break;
    }
  }
  parts.push({ kind: 'text', text: `${action.id}: ${description}` });
  if (action.kind === 'capture')
    (action.artifacts ?? []).forEach((ref, index) => {
      if (index > 0) parts.push({ kind: 'text', text: ', ' });
      parts.push({ kind: 'artifact', path: ref.path, label: `part ${index + 1}` });
    });
  if (action.call_id !== null)
    parts.push({ kind: 'text', text: ` (call ${clean(action.call_id)})` });
  return parts;
}
