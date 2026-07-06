/**
 * Confirmation gateway — the executor's consent checkpoint port.
 *
 * When a step flagged `requires_confirmation` is about to execute, the
 * executor builds a `ConfirmationRequest`, persists it to
 * `confirmations.jsonl`, emits a `confirmation_requested` event, then
 * calls `gateway.request()` — which blocks until a human-operated
 * `ConnectorIO` resolves it.
 *
 * The gateway is constructor-injected (DI per memory §Architecture).
 * Absence of a gateway + presence of a flagged step = validation-time
 * error (never silently skip consent).
 *
 * @see .spec-lite/features/feature_human_in_the_loop.md §3, TASK-002
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ConfirmationDecision, ConfirmationRequest } from '@yantra/protocol';

/**
 * Signal returned by an **unattended** gateway (the daemon, FEAT-021) that
 * cannot resolve consent itself. Instead of granting or denying, it **parks**
 * the run: the request stays pending in `confirmations.jsonl`, the executor
 * checkpoints before the flagged step (resumable), and a human later resolves
 * it out-of-band via `yantra confirm <run-id> grant|deny`.
 *
 * This is the type-level embodiment of plan §6's rule "unattended runs cannot
 * self-authorize": a scheduled fire that reaches a flagged step can only ever
 * park — it has no code path to a `granted` decision.
 */
export interface ConfirmationParked {
  readonly kind: 'parked';
}

/**
 * The result of a gateway `request()` — either a terminal human decision, or a
 * {@link ConfirmationParked} signal (unattended surfaces only). The CLI's
 * interactive gateway never returns `parked`; the daemon's gateway always does.
 */
export type ConfirmationOutcome = ConfirmationDecision | ConfirmationParked;

/** Type guard: is this gateway outcome a park signal (vs. a terminal decision)? */
export function isParked(outcome: ConfirmationOutcome): outcome is ConfirmationParked {
  return (outcome as ConfirmationParked).kind === 'parked';
}

/**
 * Port the executor calls to obtain a human consent decision.
 *
 * The single `request()` method blocks until the connector resolves
 * the request (grant, deny, or timeout) — or, for an unattended surface,
 * returns a {@link ConfirmationParked} signal. The implementation is
 * responsible for rendering the consent card (CLI) or sending a
 * notification (daemon/FEAT-021) and awaiting the response.
 */
export interface ConfirmationGateway {
  /**
   * Request human consent for a flagged action.
   *
   * @param request - The structured confirmation request.
   * @returns A terminal human decision, or a park signal (unattended only).
   */
  request(request: ConfirmationRequest): Promise<ConfirmationOutcome>;
}

/**
 * Append-only JSONL writer/reader for `confirmations.jsonl`.
 *
 * One line per request and per decision. A pending request = a request
 * line without a matching decision line. Same atomic-append pattern as
 * `events.jsonl`.
 */
export class ConfirmationStore {
  constructor(private readonly filePath: string) {}

  /** Append a request line to the JSONL file. */
  async appendRequest(request: ConfirmationRequest): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const line = JSON.stringify(request) + '\n';
    await appendFile(this.filePath, line, 'utf8');
  }

  /** Append a decision line to the JSONL file. */
  async appendDecision(decision: ConfirmationDecision): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const line = JSON.stringify(decision) + '\n';
    await appendFile(this.filePath, line, 'utf8');
  }

  /**
   * Read all entries from the JSONL file.
   * Returns a union array of requests and decisions in append order.
   */
  async readAll(): Promise<ConfirmationEntry[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }

    const entries: ConfirmationEntry[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if ('confirmation_id' in parsed && 'decision' in parsed) {
          entries.push({ kind: 'decision', data: parsed as unknown as ConfirmationDecision });
        } else if ('confirmation_id' in parsed && 'requested_at' in parsed) {
          entries.push({ kind: 'request', data: parsed as unknown as ConfirmationRequest });
        }
      } catch {
        // Skip malformed lines — append-only files may have partial writes
      }
    }
    return entries;
  }

  /**
   * Find the pending (unresolved) request for a given run.
   * Returns null if no pending request exists.
   */
  async findPending(runId: string): Promise<ConfirmationRequest | null> {
    const entries = await this.readAll();
    const requests = entries.filter((e) => e.kind === 'request') as {
      kind: 'request';
      data: ConfirmationRequest;
    }[];
    const decisions = entries.filter((e) => e.kind === 'decision') as {
      kind: 'decision';
      data: ConfirmationDecision;
    }[];

    const resolvedIds = new Set(decisions.map((d) => d.data.confirmation_id));

    for (let i = requests.length - 1; i >= 0; i--) {
      const req = requests[i]!.data;
      if (req.run_id === runId && !resolvedIds.has(req.confirmation_id)) {
        return req;
      }
    }
    return null;
  }

  /**
   * Check whether a confirmation_id already has a decision (double-resolution guard).
   */
  async hasDecision(confirmationId: string): Promise<boolean> {
    const entries = await this.readAll();
    return entries.some((e) => e.kind === 'decision' && e.data.confirmation_id === confirmationId);
  }

  /**
   * Returns the most recent decision for a run (across all its requests), or
   * null when the run has no decision yet. Used by the scheduler daemon's
   * poll-pickup to detect a parked run that a human has since granted or denied
   * out-of-band via `yantra confirm`.
   */
  async latestDecision(runId: string): Promise<ConfirmationDecision | null> {
    const entries = await this.readAll();
    const requestIds = new Set(
      entries
        .filter((e): e is { kind: 'request'; data: ConfirmationRequest } => e.kind === 'request')
        .map((e) => e.data)
        .filter((r) => r.run_id === runId)
        .map((r) => r.confirmation_id),
    );
    let latest: ConfirmationDecision | null = null;
    for (const entry of entries) {
      if (entry.kind === 'decision' && requestIds.has(entry.data.confirmation_id)) {
        latest = entry.data;
      }
    }
    return latest;
  }
}

export type ConfirmationEntry =
  | { readonly kind: 'request'; readonly data: ConfirmationRequest }
  | { readonly kind: 'decision'; readonly data: ConfirmationDecision };

/**
 * Factory: create a `ConfirmationStore` for a given run directory.
 * The file lives at `runs/<run-id>/confirmations.jsonl`.
 */
export function createConfirmationStore(runDir: string): ConfirmationStore {
  return new ConfirmationStore(join(runDir, 'confirmations.jsonl'));
}
