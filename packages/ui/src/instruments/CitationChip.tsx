import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Button } from '../primitives/Button.js';
import { Tooltip, TooltipTrigger } from '../primitives/Tooltip.js';

/**
 * CitationChip (FEAT-066): a source citation `[n]` or an action citation
 * `A<n>` as a button. Its accessible name says what it opens ("Source 3",
 * "Action A2"); a tooltip previews the evidence (host and title, or action
 * kind and label). Pressing it selects the evidence in the page's evidence
 * pane; one press, never a dead chip.
 */

export interface CitationChipProps {
  readonly kind: 'source' | 'action';
  /** The source number (`3`) or action id (`A2`). */
  readonly id: string;
  /** Host and title, or action kind and label. */
  readonly preview?: string;
  /** Called with the chip itself, so a pane can return focus to it. */
  readonly onPress: (chip: HTMLElement) => void;
  readonly className?: string;
}

/** The chip's accessible name. */
export function citationLabel(kind: 'source' | 'action', id: string): string {
  return kind === 'source' ? `Source ${id}` : `Action ${id}`;
}

/** See the module comment. */
export function CitationChip({
  kind,
  id,
  preview,
  onPress,
  className,
}: CitationChipProps): ReactNode {
  const button = (
    <Button
      variant="quiet"
      size="sm"
      aria-label={citationLabel(kind, id)}
      data-citation={kind}
      data-citation-id={id}
      onPress={(event) => {
        onPress(event.target as HTMLElement);
      }}
      className={cn('type-engine mx-0.5 h-6 px-1.5 align-baseline', className)}
    >
      {kind === 'source' ? `[${id}]` : id}
    </Button>
  );
  if (preview === undefined || preview.length === 0) return button;
  return (
    <TooltipTrigger>
      {button}
      <Tooltip>{preview}</Tooltip>
    </TooltipTrigger>
  );
}
