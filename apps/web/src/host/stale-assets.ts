/**
 * Stale-asset detection (FEAT-065 TASK-011, D17).
 *
 * The page's build ID is in `<meta name="yantra-build-id">`; the host's
 * arrives in `host.hello` and the `host.build` notification. On a mismatch
 * the page waits until it is idle (no request in flight and no focused text
 * input), asks for a fresh window-bound code (`session.launch_code`) and
 * reloads at `/#code=<code>`. Storage is not involved.
 */

/** The page's own build ID, or `dev` when the meta tag is absent. */
export function pageBuildId(doc: Document): string {
  return doc.querySelector('meta[name="yantra-build-id"]')?.getAttribute('content') ?? 'dev';
}

/** True when the user is typing: a focused input, textarea or editable element. */
export function isTyping(doc: Document): boolean {
  const active = doc.activeElement;
  if (active === null || active === doc.body) return false;
  const tag = active.tagName;
  return (
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (tag === 'INPUT' && (active as HTMLInputElement).type !== 'button') ||
    (active as HTMLElement).isContentEditable === true
  );
}

export interface StaleAssetDeps {
  readonly pageBuildId: string;
  readonly rpc: {
    readonly pendingCount: number;
    request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  };
  readonly isTyping: () => boolean;
  /** Navigates to `/#code=<code>` and reloads. */
  readonly reload: (code: string) => void;
  readonly timers?: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  /** How often to re-check for idle while waiting. */
  readonly idlePollMs?: number;
}

/** Reloads into the host's build when the page's assets are stale. */
export class StaleAssetWatcher {
  private waiting: unknown = null;
  private reloading = false;

  public constructor(private readonly deps: StaleAssetDeps) {}

  /** True while a reload is pending. */
  public get stale(): boolean {
    return this.waiting !== null || this.reloading;
  }

  /** Called with the host's build ID (hello and every `host.build`). */
  public check(hostBuildId: string): void {
    if (hostBuildId === this.deps.pageBuildId || this.stale) return;
    this.tryReload();
  }

  private tryReload(): void {
    this.waiting = null;
    if (this.deps.rpc.pendingCount > 0 || this.deps.isTyping()) {
      const timers = this.deps.timers ?? {
        setTimeout: (callback: () => void, ms: number) => window.setTimeout(callback, ms),
        clearTimeout: (handle: unknown) => {
          window.clearTimeout(handle as number);
        },
      };
      this.waiting = timers.setTimeout(() => {
        this.tryReload();
      }, this.deps.idlePollMs ?? 1_000);
      return;
    }
    this.reloading = true;
    void this.deps.rpc
      .request<{ code: string }>('session.launch_code')
      .then(({ code }) => {
        this.deps.reload(code);
      })
      .catch(() => {
        // The session ended or the socket dropped; the next hello retries.
        this.reloading = false;
      });
  }
}

/** The real reload: put the code in the fragment and reload the document. */
export function reloadWithCode(code: string): void {
  window.history.replaceState(null, '', `/#code=${code}`);
  window.location.reload();
}
