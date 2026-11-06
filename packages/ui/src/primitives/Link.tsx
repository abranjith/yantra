import type { ReactNode } from 'react';
import { Link as AriaLink } from 'react-aria-components';

import { Icon } from '../icons/Icon.js';
import { focusRing, tv } from '../lib/cn.js';

/** How a link target is treated (spec S9). */
export type HrefKind = 'internal' | 'external' | 'unsafe';

/** A base that no real URL shares, so "same origin" means "app-relative". */
const APP_BASE = 'https://drshya.app.invalid/';
const APP_ORIGIN = new URL(APP_BASE).origin;

/**
 * Classifies an untrusted href (spec S9; plan_ui §7: page-derived URLs are
 * untrusted). The href is parsed exactly as a browser would, so control
 * characters, odd casing and backslashes resolve the same way here as in the
 * address bar.
 *
 * - `internal`: resolves inside the app (`/runs/1`, `#summary`, `?q=1`).
 * - `external`: an absolute `http:` or `https:` URL, or protocol-relative.
 * - `unsafe`: anything else — `javascript:`, `data:`, `file:`, `blob:`,
 *   other schemes, empty or unparsable input.
 */
export function classifyHref(href: string): HrefKind {
  if (href.trim() === '') {
    return 'unsafe';
  }
  let url: URL;
  try {
    url = new URL(href, APP_BASE);
  } catch {
    return 'unsafe';
  }
  if (url.origin === APP_ORIGIN) {
    return 'internal';
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? 'external' : 'unsafe';
}

export const linkStyles = tv({
  extend: focusRing,
  base: 'inline-flex items-baseline gap-1 rounded-chip text-accent-ink underline underline-offset-2 hover:decoration-2',
});

export interface LinkProps {
  /** Untrusted; classified by {@link classifyHref}. */
  readonly href: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * A link that can never emit an unsafe URL. External links open in a new
 * browsing context with `rel="noopener noreferrer"` and say so; unsafe hrefs
 * render as plain secondary text, never as a link.
 */
export function Link({ href, children, className }: LinkProps): ReactNode {
  const kind = classifyHref(href);
  if (kind === 'unsafe') {
    return <span className="text-ink-2">{children}</span>;
  }
  if (kind === 'internal') {
    return (
      <AriaLink href={href} className={linkStyles({ className })}>
        {children}
      </AriaLink>
    );
  }
  return (
    <AriaLink
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={linkStyles({ className })}
    >
      {children}
      <Icon name="action.openExternal" size={16} className="self-center" />
      <span className="sr-only">(opens in a new tab)</span>
    </AriaLink>
  );
}
