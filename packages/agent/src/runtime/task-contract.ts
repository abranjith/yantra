/**
 * The run's declared task contract (FEAT-052): what the user's goal requires —
 * the deliverable, the fields each row or answer needs, every stated filter,
 * and any site the goal names.
 *
 * The contract is model-authored, so it is sanitized and normalized before it
 * is stored, persisted, echoed, or logged, and it grants nothing: no URL
 * provenance, allowlist, or budget is ever derived from it. Declaring one is
 * optional; a `research`/`do` run that never declares one carries a Brief
 * notice saying so.
 *
 * The host helpers are pure so delivery checking (FEAT-053) can call them.
 */

import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PayloadSanitizer } from '@yantra/core';
import {
  SOURCE_HOST_PATTERN,
  TASK_CONTRACT_MAX_REVISIONS,
  TASK_CONTRACT_SCHEMA_VERSION,
  TaskContractBody,
  TaskContractRecord,
  err,
  ok,
  type BriefNotice,
  type Result,
} from '@yantra/protocol';

import type { AgenticCommand } from './profiles.js';

/** The file a declared contract is persisted to, inside the run directory. */
export const CONTRACT_FILE = 'contract.json';

/** Longest rendered contract echo, ellipsis included. */
export const CONTRACT_ECHO_MAX = 400;

/** The fixed reason of the missing-contract Brief notice. */
export const MISSING_CONTRACT_REASON =
  'No task contract was declared, so the deliverable, required fields, filters, and required ' +
  'sources were not recorded for this run.';

/** The raw `task_contract` parameters, as the model sent them. */
export interface TaskContractParams {
  readonly deliverable: 'table' | 'answer' | 'report';
  readonly subject: string;
  readonly required_fields?: readonly string[];
  readonly filters?: readonly { readonly name: string; readonly value: string }[];
  readonly required_sources?: readonly string[];
  readonly ranking?: { readonly field: string; readonly direction: 'asc' | 'desc' };
  readonly limit?: number;
  readonly notes?: string;
}

/** The first problem found in a contract; each cause has its own message. */
export type ContractIssue =
  | { readonly cause: 'contract-source-host'; readonly entry: string }
  | { readonly cause: 'contract-duplicate'; readonly name: string }
  | { readonly cause: 'contract-table-fields' }
  | { readonly cause: 'contract-ranking-field'; readonly field: string };

/** How contract text is made safe to keep: sanitizer plus the run's input vault. */
export interface ContractTextCleaning {
  readonly sanitizer: PayloadSanitizer;
  /** Masks the user's own marked values back to placeholders before persistence. */
  readonly mask?: (text: string) => string;
}

// C0 and C1 control characters, DEL included.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]+/gu;

/**
 * Validates, sanitizes, and normalizes a declared contract.
 *
 * Order: clean every string (mask, `public` sanitizer profile, strip control
 * characters, trim); normalize each required source to a hostname; reject
 * case-insensitive duplicates; require fields for a table; require a table's
 * ranking to order by one of its fields. Only the first issue is returned, so
 * one call yields one cause-specific message.
 */
export function normalizeContract(
  params: TaskContractParams,
  cleaning: ContractTextCleaning,
): Result<TaskContractBody, ContractIssue> {
  const clean = (value: string, max: number): string => cleanText(value, max, cleaning);

  const fields = (params.required_fields ?? []).map((field) => clean(field, 60));
  const filters = (params.filters ?? []).map((filter) => ({
    name: clean(filter.name, 60),
    value: clean(filter.value, 120),
  }));
  const sources: string[] = [];
  for (const raw of params.required_sources ?? []) {
    const host = normalizeSourceHost(raw);
    if (host === null) return err({ cause: 'contract-source-host', entry: clean(raw, 80) });
    sources.push(host);
  }

  const duplicate =
    firstDuplicate(fields) ??
    firstDuplicate(filters.map((filter) => filter.name)) ??
    firstDuplicate(sources);
  if (duplicate !== null) return err({ cause: 'contract-duplicate', name: duplicate });

  if (params.deliverable === 'table' && fields.length === 0) {
    return err({ cause: 'contract-table-fields' });
  }
  const ranking =
    params.ranking === undefined
      ? null
      : { field: clean(params.ranking.field, 60), direction: params.ranking.direction };
  if (
    params.deliverable === 'table' &&
    ranking !== null &&
    !fields.some((field) => field.toLowerCase() === ranking.field.toLowerCase())
  ) {
    return err({ cause: 'contract-ranking-field', field: ranking.field });
  }

  const notes = params.notes === undefined ? '' : clean(params.notes, 500);
  // The input schema already bounds every value, and cleaning only shortens or
  // redacts it, so a failure here is a defect in this function, not bad input.
  return ok(
    TaskContractBody.parse({
      deliverable: params.deliverable,
      subject: clean(params.subject, 200),
      required_fields: fields,
      filters,
      required_sources: sources,
      ranking,
      limit: params.limit ?? null,
      notes: notes.length === 0 ? null : notes,
    }),
  );
}

/**
 * Normalizes a site the goal names to a bare hostname: lowercase, no scheme,
 * credentials, path, port, or trailing dot, and no leading `www.`.
 *
 * @returns The hostname, or null when the entry is not an http(s) host with a dot.
 */
export function normalizeSourceHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /\s/u.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    // An unparseable entry is the caller's `contract-source-host` cause.
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  const host = stripWww(url.hostname.toLowerCase().replace(/\.$/u, ''));
  return host.length <= 253 && SOURCE_HOST_PATTERN.test(host) ? host : null;
}

/**
 * True when `url` is served by one of the contract's required sources: its
 * hostname, minus a leading `www.`, equals a source or is a subdomain of one.
 */
export function hostSatisfiesRequiredSource(url: string, contract: TaskContractBody): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Not a URL, so it cannot satisfy a source.
    return false;
  }
  const host = stripWww(hostname.toLowerCase().replace(/\.$/u, ''));
  return contract.required_sources.some((source) => host === source || host.endsWith(`.${source}`));
}

/**
 * One line telling the user what the run understood, built only from the
 * normalized contract: no newlines or control characters, at most
 * {@link CONTRACT_ECHO_MAX} characters.
 */
export function renderContractEcho(body: TaskContractBody): string {
  const parts: string[] = [];
  if (body.required_fields.length > 0) parts.push(`fields: ${body.required_fields.join(', ')}`);
  if (body.filters.length > 0) {
    parts.push(
      `filters: ${body.filters.map((filter) => `${filter.name}=${filter.value}`).join(', ')}`,
    );
  }
  if (body.required_sources.length > 0) parts.push(`sources: ${body.required_sources.join(', ')}`);
  if (body.ranking !== null) {
    parts.push(
      `ranked by ${body.ranking.field} ${body.ranking.direction === 'asc' ? 'ascending' : 'descending'}`,
    );
  }
  if (body.limit !== null) parts.push(`top ${body.limit}`);
  if (body.notes !== null) parts.push(`note: ${body.notes}`);
  const line =
    `${body.deliverable} of ${body.subject}${parts.length > 0 ? ` — ${parts.join('; ')}` : ''}`
      .replace(CONTROL_CHARACTERS, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
  return line.length <= CONTRACT_ECHO_MAX ? line : `${line.slice(0, CONTRACT_ECHO_MAX - 1)}…`;
}

/** Thrown when a declaration would exceed {@link TASK_CONTRACT_MAX_REVISIONS}. */
export class ContractRevisionLimitError extends Error {
  public constructor() {
    super(`The task contract is fixed at revision ${TASK_CONTRACT_MAX_REVISIONS}.`);
    this.name = 'ContractRevisionLimitError';
  }
}

/** Construction inputs for one run's {@link TaskContractStore}. */
export interface TaskContractStoreOptions {
  readonly runId: string;
  readonly runDir: string;
  readonly command: AgenticCommand;
  /** True for `research`/`do`: a run that never declares one gets a notice. */
  readonly required: boolean;
}

/**
 * The run's contract: every revision in declaration order, the last current.
 *
 * Each declaration rewrites `contract.json` atomically before it takes effect,
 * so a run that dies later still has its contract on disk, and a write that
 * fails leaves the run exactly as it was (so it still gets the notice).
 */
export class TaskContractStore {
  private revisions: TaskContractRecord['revisions'] = [];
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: TaskContractStoreOptions) {}

  /** Whether this run's command is expected to declare a contract. */
  public get required(): boolean {
    return this.options.required;
  }

  /**
   * Appends a revision and persists the whole record.
   *
   * @param body A contract already normalized by {@link normalizeContract}.
   * @param at ISO-8601 declaration time.
   * @throws ContractRevisionLimitError at the revision limit; a write failure propagates.
   */
  public declare(body: TaskContractBody, at: string): Promise<{ readonly revision: number }> {
    // Serialized so parallel declarations cannot interleave their writes.
    const next = this.queue.then(() => this.append(body, at));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** The current contract, or null before the first declaration. */
  public current(): TaskContractBody | null {
    return this.revisions.at(-1)?.contract ?? null;
  }

  /** The contract as declared at 1-based `revision`, or null when there is none. */
  public revisionAt(revision: number): TaskContractBody | null {
    return this.revisions[revision - 1]?.contract ?? null;
  }

  /** Revisions declared so far. */
  public revisionCount(): number {
    return this.revisions.length;
  }

  /** Exactly one notice when a contract was required and never declared. */
  public notices(): BriefNotice[] {
    return this.options.required && this.current() === null
      ? [{ kind: 'other', source: 'task-contract', reason: MISSING_CONTRACT_REASON }]
      : [];
  }

  private async append(body: TaskContractBody, at: string): Promise<{ revision: number }> {
    if (this.revisions.length >= TASK_CONTRACT_MAX_REVISIONS) {
      throw new ContractRevisionLimitError();
    }
    const { command } = this.options;
    if (command !== 'research' && command !== 'do') {
      throw new Error(`The ${command} command cannot declare a task contract.`);
    }
    const revision = this.revisions.length + 1;
    const revisions = [...this.revisions, { revision, declared_at: at, contract: body }];
    const record = TaskContractRecord.parse({
      schema_version: TASK_CONTRACT_SCHEMA_VERSION,
      run_id: this.options.runId,
      command,
      revisions,
    });
    const path = join(this.options.runDir, CONTRACT_FILE);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    this.revisions = record.revisions;
    return { revision };
  }
}

function cleanText(value: string, max: number, cleaning: ContractTextCleaning): string {
  const masked = cleaning.mask?.(value) ?? value;
  const sanitized = cleaning.sanitizer.sanitize(masked, 'public').text;
  const stripped = sanitized.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/gu, ' ').trim();
  return stripped.length <= max ? stripped : `${stripped.slice(0, max - 1)}…`;
}

function firstDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) return value;
    seen.add(key);
  }
  return null;
}

function stripWww(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}
