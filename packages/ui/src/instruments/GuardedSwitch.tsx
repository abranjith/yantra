import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import { cn } from '../lib/cn.js';

export interface GuardedSwitchProps {
  readonly actionLabel: string;
  readonly consequence?: string;
  readonly deadlineAt: string | null;
  readonly onDecide: (decision: 'granted' | 'denied') => void | Promise<unknown>;
  readonly disabled?: boolean;
  readonly pendingResponse?: boolean;
}

const HOLD_MS = 1_200;

/** Consent control: pointer approval requires a hold; keyboard approval requires review. */
export function GuardedSwitch({
  actionLabel,
  consequence = 'This action may have lasting effects.',
  deadlineAt,
  onDecide,
  disabled = false,
  pendingResponse = false,
}: GuardedSwitchProps): ReactNode {
  const [review, setReview] = useState(false);
  const [holding, setHolding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(() => remainingSeconds(deadlineAt));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!review) return;
    denyRef.current?.focus();
  }, [review]);

  useEffect(() => {
    if (deadlineAt === null) return;
    const update = (): void => setRemaining(remainingSeconds(deadlineAt));
    update();
    const interval = setInterval(update, 1_000);
    return () => clearInterval(interval);
  }, [deadlineAt]);

  useEffect(() => () => clearHold(), []);

  const decide = (decision: 'granted' | 'denied'): void => {
    if (disabled || pendingResponse || submitting) return;
    setSubmitting(true);
    void Promise.resolve(onDecide(decision)).finally(() => setSubmitting(false));
    setReview(false);
    openerRef.current?.focus();
  };

  const startHold = (): void => {
    if (disabled || pendingResponse || submitting || remaining === 0) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      decide('granted');
    }, HOLD_MS);
  };

  function clearHold(): void {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  }

  return (
    <section className="flex flex-col gap-3" aria-label={`Confirmation: ${actionLabel}`}>
      <p className="text-caption text-ink-2">{actionLabel}</p>
      <p className="text-caption text-ink-2">{consequence}</p>
      <p className="text-micro text-ink-3" aria-live="polite">
        {remaining === null
          ? 'No time limit while you are here'
          : remaining === 0
            ? 'Expired'
            : `${remaining} seconds remaining`}
      </p>
      {!review ? (
        <div className="flex gap-2">
          <button
            ref={openerRef}
            type="button"
            disabled={disabled || pendingResponse || submitting || remaining === 0}
            className={cn(
              'relative inline-flex items-center gap-2 overflow-hidden rounded-chip border border-accent px-4 py-2 text-caption text-ink',
              'focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50',
            )}
            onPointerDown={(event) => {
              if (event.pointerType === 'mouse' || event.pointerType === 'touch') startHold();
            }}
            onPointerUp={clearHold}
            onPointerCancel={clearHold}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setReview(true);
              }
            }}
            onClick={(event) => {
              if (event.detail > 0) event.preventDefault();
            }}
          >
            {holding ? <span className="absolute inset-y-0 left-0 w-full bg-accent/30" /> : null}
            <Icon name="nav.check" size={16} aria-hidden="true" />
            <span className="relative">Approve</span>
          </button>
          <button
            type="button"
            disabled={disabled || pendingResponse || submitting}
            className="rounded-chip border border-rule px-4 py-2 text-caption text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
            onClick={() => decide('denied')}
          >
            Deny
          </button>
        </div>
      ) : (
        <div
          className="flex gap-2 rounded-card border border-rule p-3"
          role="group"
          aria-label="Review approval"
        >
          <button
            ref={denyRef}
            type="button"
            className="rounded-chip border border-rule px-4 py-2 text-caption text-ink focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => decide('denied')}
          >
            Deny
          </button>
          <button
            type="button"
            className="rounded-chip border border-accent px-4 py-2 text-caption text-ink focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => decide('granted')}
          >
            Approve
          </button>
          <button
            type="button"
            className="text-caption text-ink-3"
            onClick={() => {
              setReview(false);
              openerRef.current?.focus();
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}

function remainingSeconds(deadlineAt: string | null): number | null {
  if (deadlineAt === null) return null;
  const delta = Date.parse(deadlineAt) - Date.now();
  return Math.max(0, Math.ceil(delta / 1_000));
}

export function guardedSwitchHoldMs(): number {
  return HOLD_MS;
}
