/**
 * The app's one toast queue (FEAT-067): created by the shell, reached through
 * {@link useToasts}. Toasts are polite and never move focus (Drshya Toast).
 */

import { ToastProvider, createToastQueue, type DrshyaToastQueue } from '@yantra/ui';
import { createContext, useContext, useState, type ReactNode } from 'react';

const ToastContext = createContext<DrshyaToastQueue | null>(null);

/** Creates the shell's queue and renders its region. */
export function AppToasts({ children }: { readonly children: ReactNode }): ReactNode {
  const [queue] = useState(() => createToastQueue());
  return (
    <ToastContext.Provider value={queue}>
      <ToastProvider queue={queue}>{children}</ToastProvider>
    </ToastContext.Provider>
  );
}

/** The shell's toast queue, or null outside the shell (tests of a lone component). */
export function useToasts(): DrshyaToastQueue | null {
  return useContext(ToastContext);
}
