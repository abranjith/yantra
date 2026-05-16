/// <reference lib="dom" />
/**
 * In-page overlay entry point.
 *
 * Registers `window.__yantraRecorder` and draws the recording indicator.
 * Injected via `Page.addScriptToEvaluateOnNewDocument` so it loads before
 * any page script on every navigation.
 *
 * NO Node.js APIs. Zero external dependencies (bundled as IIFE by esbuild).
 */

import { buildElementDescriptor } from './descriptor-builder.js';
import { installEventListeners } from './event-listeners.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecorderOverlayState {
  status: 'recording' | 'paused';
  actionCount: number;
  lastActionAt: number;
}

interface RecorderOverlay {
  state: RecorderOverlayState;
  updateCount(count: number): void;
  showToast(message: string): void;
}

declare global {
  interface Window {
    __yantraRecorder: RecorderOverlay;
    /** CDP binding registered by Node-side before injection. */
    __yantraRecorderEmit: (payload: string) => void;
  }
}

// ---------------------------------------------------------------------------
// Overlay UI
// ---------------------------------------------------------------------------

function createOverlayElement(): HTMLElement {
  const overlay = document.createElement('div');
  overlay.id = '__yantra-recorder-overlay';
  overlay.style.cssText = [
    'position:fixed',
    'top:8px',
    'right:8px',
    'z-index:2147483647',
    'display:flex',
    'align-items:center',
    'gap:6px',
    'background:rgba(0,0,0,0.75)',
    'color:#fff',
    'font:12px/1.4 monospace',
    'padding:4px 8px',
    'border-radius:4px',
    'pointer-events:none',
    'user-select:none',
  ].join(';');

  // Red dot
  const dot = document.createElement('span');
  dot.id = '__yantra-recorder-dot';
  dot.style.cssText =
    'width:8px;height:8px;border-radius:50%;background:#f55;display:inline-block;animation:__yantra-pulse 1.5s ease-in-out infinite';
  overlay.appendChild(dot);

  // Counter label
  const label = document.createElement('span');
  label.id = '__yantra-recorder-count';
  label.textContent = '0 captured';
  overlay.appendChild(label);

  // Hint
  const hint = document.createElement('span');
  hint.style.opacity = '0.6';
  hint.textContent = '• stop with Ctrl+C';
  overlay.appendChild(hint);

  // Toast slot
  const toast = document.createElement('div');
  toast.id = '__yantra-recorder-toast';
  toast.style.cssText = [
    'position:fixed',
    'bottom:16px',
    'right:16px',
    'z-index:2147483647',
    'background:rgba(0,0,0,0.85)',
    'color:#fff',
    'font:12px/1.4 monospace',
    'padding:6px 10px',
    'border-radius:4px',
    'display:none',
    'pointer-events:none',
    'max-width:320px',
  ].join(';');
  overlay.parentElement?.appendChild(toast);

  return overlay;
}

function injectCSS(): void {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes __yantra-pulse {
      0%,100% { opacity: 1; }
      50%      { opacity: 0.35; }
    }
  `;
  document.head?.appendChild(style);
}

let overlayEl: HTMLElement | null = null;
let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function mountOverlay(): void {
  if (document.getElementById('__yantra-recorder-overlay')) return;

  injectCSS();
  overlayEl = createOverlayElement();
  document.body?.appendChild(overlayEl);
  toastEl = document.getElementById('__yantra-recorder-toast');
}

// ---------------------------------------------------------------------------
// Public overlay object
// ---------------------------------------------------------------------------

const overlay: RecorderOverlay = {
  state: {
    status: 'recording',
    actionCount: 0,
    lastActionAt: performance.now(),
  },

  updateCount(count: number): void {
    this.state.actionCount = count;
    this.state.lastActionAt = performance.now();

    const label = document.getElementById('__yantra-recorder-count');
    if (label) label.textContent = `${count} captured`;
  },

  showToast(message: string): void {
    if (!toastEl) toastEl = document.getElementById('__yantra-recorder-toast');
    if (!toastEl) return;

    toastEl.textContent = message;
    toastEl.style.display = 'block';

    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.style.display = 'none';
    }, 4000);
  },
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function bootstrap(): void {
  window.__yantraRecorder = overlay;

  // Mount overlay once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountOverlay, { once: true });
  } else {
    mountOverlay();
  }

  // Install capturing-phase event listeners
  installEventListeners({
    onActionCaptured(count: number) {
      overlay.updateCount(count);
    },
  });
}

// Export for testing and for the bundle entry
export { buildElementDescriptor, bootstrap };

// Auto-bootstrap when loaded as an IIFE in the page
bootstrap();
