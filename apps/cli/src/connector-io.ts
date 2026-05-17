/**
 * `ConnectorIO` — the seam between an external IO surface (CLI today;
 * WhatsApp / email / web in Phase 2) and Yantra's inline executor.
 *
 * Responsibilities (the only three the interface owns):
 *
 *   1. Build a `TaskRequest` from the connector's native input shape.
 *   2. Subscribe to the `TaskEvent` stream for the lifetime of one task.
 *   3. Render the final outcome and signal completion.
 *
 * Designed *now* so the Phase 2 split is a mechanical "add another
 * implementation" task, not a redesign. Resist the urge to grow the
 * interface — anything that doesn't fit these three responsibilities
 * belongs in surface-specific glue, not here.
 *
 * @see .spec-lite/features/feature_cli_polish_distribution.md §2.2.1
 */

import type { TaskEvent } from '@yantra/protocol';

import type { GlobalFlags } from './global-flags.js';
import type {
  AuditRenderReport,
  ConnectorRenderOpts,
  DoctorRenderResult,
  ListItem,
  OutputRenderer,
  ShowItem,
} from './render/types.js';

export type ConnectorId = 'cli' | 'whatsapp' | 'email' | 'web';

export type ConnectorResult =
  | { readonly kind: 'list'; readonly items: readonly ListItem[] }
  | { readonly kind: 'show'; readonly item: ShowItem }
  | { readonly kind: 'doctor'; readonly result: DoctorRenderResult }
  | { readonly kind: 'audit'; readonly report: AuditRenderReport }
  | { readonly kind: 'report'; readonly markdown: string };

export interface ConnectorIO {
  readonly id: ConnectorId;

  /**
   * Subscribes a handler to the task event stream for the lifetime of one
   * task. The returned disposer is idempotent — calling it twice is safe.
   */
  onEvent(handler: (event: TaskEvent) => void): () => void;

  /**
   * Renders the final outcome to the connector surface. For CLI this writes
   * to stdout (terminal or JSON); for Phase 2 connectors this returns a
   * typed reply object instead.
   */
  renderResult(result: ConnectorResult, opts: ConnectorRenderOpts): void;
}

/**
 * Trivial in-process event bus the CLI uses when there isn't a wider one
 * available (e.g. for the audit/doctor commands which produce no
 * `TaskEvent`s). Phase 2 swaps in the FEAT-005 EventBus.
 */
class NoopEventStream {
  private readonly handlers = new Set<(event: TaskEvent) => void>();

  subscribe(handler: (event: TaskEvent) => void): () => void {
    this.handlers.add(handler);
    let disposed = false;
    return (): void => {
      if (disposed) return;
      disposed = true;
      this.handlers.delete(handler);
    };
  }
}

export class CLIConnectorIO implements ConnectorIO {
  readonly id: ConnectorId = 'cli';
  private readonly events = new NoopEventStream();

  constructor(private readonly renderer: OutputRenderer) {}

  onEvent(handler: (event: TaskEvent) => void): () => void {
    return this.events.subscribe(handler);
  }

  renderResult(result: ConnectorResult, opts: ConnectorRenderOpts): void {
    switch (result.kind) {
      case 'list':
        this.renderer.renderList(result.items, opts);
        return;
      case 'show':
        this.renderer.renderShow(result.item, opts);
        return;
      case 'doctor':
        this.renderer.renderDoctor(result.result, opts);
        return;
      case 'audit':
        this.renderer.renderAudit(result.report, opts);
        return;
      case 'report':
        this.renderer.renderReport(result.markdown, opts);
        return;
    }
  }
}

/** Helper for command handlers to derive render opts from global flags + streams. */
export function buildRenderOpts(
  flags: GlobalFlags,
  streams: {
    readonly stdout?: NodeJS.WritableStream;
    readonly stderr?: NodeJS.WritableStream;
  } = {},
): ConnectorRenderOpts {
  return {
    json: flags.json,
    debug: flags.debug,
    noColor: flags.noColor,
    stream: streams.stdout ?? process.stdout,
    errStream: streams.stderr ?? process.stderr,
  };
}
