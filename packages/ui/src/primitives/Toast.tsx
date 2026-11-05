/**
 * Toasts: an app-owned queue, glass toasts with a signal icon, a polite live
 * region, and no focus theft (spec S8, TASK-010).
 *
 * React Aria 1.22 still exposes its toast API as `UNSTABLE_*`. Those names
 * are wrapped here and nowhere else, so the instability never reaches
 * consumers.
 */

import type { ReactNode } from 'react';
import {
  Text,
  UNSTABLE_Toast as AriaToast,
  UNSTABLE_ToastContent as AriaToastContent,
  UNSTABLE_ToastQueue as AriaToastQueue,
  UNSTABLE_ToastRegion as AriaToastRegion,
  type QueuedToast,
} from 'react-aria-components';

import { Icon } from '../icons/Icon.js';
import type { IconName } from '../icons/registry.js';
import { cn } from '../lib/cn.js';

import { Button } from './Button.js';

export type ToastTone = 'info' | 'fulfilled' | 'partial' | 'failed' | 'needs-you';

export interface ToastAction {
  readonly label: string;
  readonly onAction: () => void;
}

export interface ToastContent {
  readonly title: string;
  readonly description?: string;
  readonly tone: ToastTone;
  /** A toast with an action never auto-dismisses (WCAG 2.2.1). */
  readonly action?: ToastAction;
}

/** Plain toasts dismiss after this long; hover and focus pause the timer. */
export const TOAST_TIMEOUT_MS = 6000;

/** Each tone: its registry icon, graphic color and the word that names it. */
export const TOAST_TONES = {
  info: { icon: 'status.info', iconClass: 'text-accent', label: 'Info' },
  fulfilled: { icon: 'outcome.fulfilled', iconClass: 'text-signal-fulfilled', label: 'Fulfilled' },
  partial: { icon: 'outcome.partial', iconClass: 'text-signal-partial', label: 'Partial' },
  failed: { icon: 'outcome.failed', iconClass: 'text-signal-failed', label: 'Failed' },
  'needs-you': { icon: 'status.needsYou', iconClass: 'text-signal-needs-you', label: 'Needs you' },
} as const satisfies Record<
  ToastTone,
  { readonly icon: IconName; readonly iconClass: string; readonly label: string }
>;

export interface ToastQueueOptions {
  /** How many toasts show at once; the rest wait. Default 5. */
  readonly maxVisibleToasts?: number;
  /**
   * Whether plain toasts dismiss on their own. Default true; the gallery
   * turns it off so its screenshot is deterministic.
   */
  readonly autoDismiss?: boolean;
}

/** An app-owned toast queue: create one per app and hand it to {@link ToastProvider}. */
export interface DrshyaToastQueue {
  /** Shows a toast and returns its key. Never moves focus. */
  add(content: ToastContent): string;
  close(key: string): void;
  clear(): void;
  /** The underlying React Aria queue, for {@link ToastProvider} only. */
  readonly aria: AriaToastQueue<ToastContent>;
}

/** Creates a toast queue. There is no module-level queue (spec S8). */
export function createToastQueue(options: ToastQueueOptions = {}): DrshyaToastQueue {
  const aria = new AriaToastQueue<ToastContent>({
    maxVisibleToasts: options.maxVisibleToasts ?? 5,
  });
  const autoDismiss = options.autoDismiss ?? true;
  return {
    add: (content) =>
      content.action === undefined && autoDismiss
        ? aria.add(content, { timeout: TOAST_TIMEOUT_MS })
        : aria.add(content),
    close: (key) => {
      aria.close(key);
    },
    clear: () => {
      aria.clear();
    },
    aria,
  };
}

function ToastItem({
  toast,
  queue,
}: {
  readonly toast: QueuedToast<ToastContent>;
  readonly queue: DrshyaToastQueue;
}): ReactNode {
  const { content } = toast;
  const tone = TOAST_TONES[content.tone];
  const action = content.action;
  return (
    <AriaToast
      toast={toast}
      data-tone={content.tone}
      className="glass flex w-88 max-w-full items-start gap-3 rounded-control p-3 text-ink outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span className={cn('mt-0.5 inline-flex', tone.iconClass)}>
        <Icon name={tone.icon} size={20} />
      </span>
      {/*
        React Aria marks toast content role="alert" (assertive). Drshya
        announces politely (plan_ui §9): status is polite, and the content
        still flips aria-hidden on mount so NVDA announces it.
      */}
      <AriaToastContent
        role="status"
        aria-live="polite"
        className="flex min-w-0 flex-1 flex-col gap-0.5"
      >
        <span className="type-label text-ink-2">{tone.label}</span>
        <Text slot="title" className="font-semibold text-ink">
          {content.title}
        </Text>
        {content.description === undefined ? null : (
          <Text slot="description" className="text-caption text-ink-2">
            {content.description}
          </Text>
        )}
        {action === undefined ? null : (
          <span className="mt-2">
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                action.onAction();
                queue.close(toast.key);
              }}
            >
              {action.label}
            </Button>
          </span>
        )}
      </AriaToastContent>
      <Button slot="close" variant="quiet" size="sm" icon="action.close" aria-label="Dismiss" />
    </AriaToast>
  );
}

export interface ToastProviderProps {
  readonly queue: DrshyaToastQueue;
  readonly children?: ReactNode;
  readonly 'aria-label'?: string;
}

/**
 * Renders `children` and the toast region for `queue`, stacked at the
 * bottom-end of the viewport (React Aria portals it into `document.body`).
 * The region is a polite live landmark: adding a toast announces it without
 * moving focus, and keyboard users reach it with F6 (React Aria landmark
 * navigation).
 */
export function ToastProvider({
  queue,
  children,
  'aria-label': ariaLabel = 'Notifications',
}: ToastProviderProps): ReactNode {
  return (
    <>
      {children}
      <AriaToastRegion
        queue={queue.aria}
        aria-label={ariaLabel}
        className="fixed right-4 bottom-4 z-50 flex flex-col-reverse gap-2 outline-hidden"
      >
        {({ toast }) => <ToastItem toast={toast} queue={queue} />}
      </AriaToastRegion>
    </>
  );
}
