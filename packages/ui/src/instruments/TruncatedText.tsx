import type { ReactNode } from 'react';
import { Focusable } from 'react-aria-components';

import { cn } from '../lib/cn.js';
import { Tooltip, TooltipTrigger } from '../primitives/Tooltip.js';

/**
 * TruncatedText (FEAT-067): one line of text cut to its box with an
 * ellipsis, whose full text shows in a tooltip on hover or focus.
 *
 * The full text stays in the DOM (only CSS cuts it), so a screen reader reads
 * all of it; the tooltip is for sighted mouse and keyboard users. The text is
 * untrusted and renders through React escaping.
 */
export interface TruncatedTextProps {
  readonly text: string;
  readonly className?: string;
}

/** See the module comment. */
export function TruncatedText({ text, className }: TruncatedTextProps): ReactNode {
  return (
    <TooltipTrigger>
      <Focusable>
        <span
          tabIndex={0}
          className={cn(
            'block min-w-0 truncate rounded-chip focus-visible:outline-2 focus-visible:outline-accent',
            className,
          )}
        >
          {text}
        </span>
      </Focusable>
      <Tooltip>{text}</Tooltip>
    </TooltipTrigger>
  );
}
