/**
 * Dialog and AlertDialog (TASK-014): modal focus management from React Aria.
 * Focus moves into the dialog when a person opens it and returns to the
 * trigger on close; Tab is contained. The panel is solid `surface` (content
 * sits on paper, brainstorm rule 1), never glass.
 */

import type { ReactNode } from 'react';
import {
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Heading,
  Modal,
  ModalOverlay,
  type DialogTriggerProps as AriaDialogTriggerProps,
  type ModalOverlayProps,
} from 'react-aria-components';

import { cn } from '../lib/cn.js';

/** Pairs a trigger with a {@link Dialog}; controlled or uncontrolled. */
export function DialogTrigger(props: AriaDialogTriggerProps): ReactNode {
  return <AriaDialogTrigger {...props} />;
}

export type DialogTriggerProps = AriaDialogTriggerProps;

export interface DialogProps extends Omit<
  ModalOverlayProps,
  'className' | 'style' | 'children' | 'isDismissable' | 'isKeyboardDismissDisabled'
> {
  /** The dialog's name, rendered as its title heading. Required. */
  readonly title: ReactNode;
  /**
   * `alertdialog` is for confirmations: Escape and an outside click do not
   * dismiss it, so the person must choose an explicit button.
   */
  readonly role?: 'dialog' | 'alertdialog';
  readonly children: ReactNode | ((controls: { readonly close: () => void }) => ReactNode);
  readonly className?: string;
}

/** A modal dialog over a `bg` scrim (`--dialog-scrim`). */
export function Dialog({
  title,
  role = 'dialog',
  children,
  className,
  ...overlay
}: DialogProps): ReactNode {
  const isAlert = role === 'alertdialog';
  return (
    <ModalOverlay
      {...overlay}
      isDismissable={!isAlert}
      isKeyboardDismissDisabled={isAlert}
      className="fixed inset-0 z-50 flex items-center justify-center bg-(--dialog-scrim) p-4"
    >
      <Modal
        className={cn(
          'w-full max-w-lg rounded-frame border border-rule-strong bg-surface text-ink',
          className,
        )}
      >
        <AriaDialog role={role} className="flex flex-col gap-4 p-6 outline-hidden">
          {({ close }) => (
            <>
              <Heading slot="title" className="m-0 text-title font-semibold text-ink">
                {title}
              </Heading>
              {typeof children === 'function' ? children({ close }) : children}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
