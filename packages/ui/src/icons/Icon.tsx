import type { ReactNode } from 'react';

import { ICON_REGISTRY, type IconName } from './registry.js';

/** Icons render at 16 or 20 px with a 1.75 stroke (brainstorm §Iconography). */
export type IconSize = 16 | 20;

export const ICON_STROKE_WIDTH = 1.75;

export interface IconProps {
  readonly name: IconName;
  readonly size?: IconSize;
  /**
   * The accessible name. Without it the icon is decorative and hidden from
   * assistive technology; a meaningful standalone icon must have one.
   */
  readonly label?: string;
  readonly className?: string;
}

/**
 * A semantic icon from the Drshya registry, in `currentColor`. Never import
 * `lucide-react` directly: lint allows it only in `registry.tsx`.
 */
export function Icon({ name, size = 16, label, className }: IconProps): ReactNode {
  const Component = ICON_REGISTRY[name].component;
  const accessibility =
    label === undefined
      ? ({ 'aria-hidden': true, focusable: 'false' } as const)
      : ({ role: 'img', 'aria-label': label } as const);
  return (
    <Component
      size={size}
      strokeWidth={ICON_STROKE_WIDTH}
      className={className}
      data-icon={name}
      {...accessibility}
    />
  );
}
