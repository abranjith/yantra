import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Disclosure as AriaDisclosure,
  DisclosurePanel as AriaDisclosurePanel,
  Heading,
  type DisclosurePanelProps as AriaDisclosurePanelProps,
  type DisclosureProps as AriaDisclosureProps,
} from 'react-aria-components';

import { Icon } from '../icons/Icon.js';
import { cn } from '../lib/cn.js';

import { buttonStyles } from './Button.js';

export interface DisclosureProps extends Omit<AriaDisclosureProps, 'className' | 'style'> {
  readonly className?: string;
}

/** A section that expands and collapses; controlled or uncontrolled (React Aria). */
export function Disclosure({ className, ...props }: DisclosureProps): ReactNode {
  return <AriaDisclosure {...props} className={cn('group flex flex-col gap-2', className)} />;
}

export interface DisclosureTriggerProps {
  readonly children: ReactNode;
  /** Wraps the trigger in a heading of this level, for document structure. */
  readonly headingLevel?: 2 | 3 | 4 | 5 | 6;
  readonly className?: string;
}

/**
 * The trigger: a quiet Drshya button with a chevron that turns when expanded.
 * The turn is a transition at `--duration-quick`, removed under reduced motion.
 */
export function DisclosureTrigger({
  children,
  headingLevel,
  className,
}: DisclosureTriggerProps): ReactNode {
  const trigger = (
    <AriaButton
      slot="trigger"
      className={buttonStyles({
        variant: 'quiet',
        size: 'md',
        className: cn('justify-start px-2', className),
      })}
    >
      <span className="inline-flex transition-transform duration-(--duration-quick) group-expanded:rotate-90">
        <Icon name="nav.chevronRight" size={16} />
      </span>
      {children}
    </AriaButton>
  );
  return headingLevel === undefined ? (
    trigger
  ) : (
    <Heading level={headingLevel} className="m-0 text-body">
      {trigger}
    </Heading>
  );
}

export interface DisclosurePanelProps extends Omit<
  AriaDisclosurePanelProps,
  'className' | 'style'
> {
  readonly className?: string;
}

/** Hidden, and out of the accessibility tree, while collapsed. */
export function DisclosurePanel({ className, ...props }: DisclosurePanelProps): ReactNode {
  return <AriaDisclosurePanel {...props} className={cn('pl-8 text-ink', className)} />;
}
