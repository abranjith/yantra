import type { ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import { cn } from '../lib/cn.js';

/**
 * ProtectedValue (FEAT-066): stands in for a value Yantra never shows — a
 * password, an autocomplete or secret-marked field, a stored secret.
 *
 * The props carry only why the value is withheld and the safe readback
 * verdict. There is **no value or length input**, so the rendered DOM is
 * identical for every underlying value: a fixed mask, never one dot per
 * character.
 */

/** Why a value is withheld (protocol `verification.withheld.reason`). */
export type ProtectedReason = 'password' | 'autocomplete' | 'secret_marker' | 'stored_secret';

/** The safe readback verdict (protocol `verification.withheld.verdict`). */
export type ProtectedVerdict = 'exact' | 'reformatted' | 'unchecked';

/** How each reason reads. */
export const PROTECTED_REASON_TEXT: Readonly<Record<ProtectedReason, string>> = {
  password: 'a password field',
  autocomplete: 'an autocomplete-protected field',
  secret_marker: 'a field marked secret',
  stored_secret: 'a stored secret',
};

/** The fixed mask: the same eight glyphs for every value. */
export const PROTECTED_MASK = '••••••••';

export interface ProtectedValueProps {
  readonly reason: ProtectedReason;
  readonly verdict?: ProtectedVerdict;
  readonly className?: string;
}

/** See the module comment. */
export function ProtectedValue({ reason, verdict, className }: ProtectedValueProps): ReactNode {
  return (
    <span
      data-part="protected-value"
      data-reason={reason}
      className={cn('inline-flex flex-wrap items-center gap-2', className)}
    >
      <span aria-hidden="true" className="type-engine rounded-chip bg-sunken px-2 text-ink-2">
        {PROTECTED_MASK}
      </span>
      <span className="inline-flex items-center gap-1 text-ink">
        <Icon name="glyph.protected" size={16} />
        <span>
          Protected — {PROTECTED_REASON_TEXT[reason]} (<span className="type-engine">{reason}</span>
          )
        </span>
      </span>
      {verdict === undefined ? null : (
        <span className="text-ink-2">
          readback <span className="type-engine">{verdict}</span>
        </span>
      )}
    </span>
  );
}
