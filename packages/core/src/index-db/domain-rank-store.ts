/**
 * SQLite repository for local domain-ranking observations.
 *
 * Rank data is deliberately excluded from run-tree rebuilds: aggregate
 * signals cannot be reconstructed faithfully from run artifacts, and `user`
 * rows are user-authored (the same precedent as preferences). A normal doctor
 * rebuild preserves this table while the database is intact; a corrupt-file
 * reset necessarily starts it empty.
 */

import { err, ok, type Result } from '@yantra/protocol';

import type { Logger } from '../browser/types.js';
import { normalizeDomain } from '../ranking/domain.js';
import type { DomainValidationError } from '../ranking/domain.js';
import type { DomainRankSignal } from '../ranking/types.js';

import type { DatabaseSync } from './sqlite.js';
import { IndexDbError } from './types.js';

export const RANK_MIN = -100;
export const RANK_MAX = 100;

/** One normalized row from `domain_ranks`. */
export interface DomainRankRecord {
  readonly domain: string;
  readonly rank: number;
  readonly positiveSignals: number;
  readonly negativeSignals: number;
  readonly origin: 'auto' | 'user';
  readonly firstSeenAt: string;
  readonly lastSignalAt: string;
}

export interface DomainRankStore {
  applySignal(signal: DomainRankSignal): Result<void, IndexDbError>;
  upsertUserDomain(domain: string): Result<DomainRankRecord, IndexDbError | DomainValidationError>;
  remove(domain: string): Result<boolean, IndexDbError | DomainValidationError>;
  list(): Result<readonly DomainRankRecord[], IndexDbError>;
}

export interface SqliteDomainRankStoreDeps {
  readonly db: DatabaseSync;
  readonly logger?: Logger;
  /** Injected clock for deterministic timestamps in tests. */
  readonly clock?: () => Date;
}

/** SQLite-backed domain rank store with bounded scores and lifetime counters. */
export class SqliteDomainRankStore implements DomainRankStore {
  private readonly db: DatabaseSync;
  private readonly logger: Logger | null;
  private readonly clock: () => Date;

  public constructor(deps: SqliteDomainRankStoreDeps) {
    this.db = deps.db;
    this.logger = deps.logger ?? null;
    this.clock = deps.clock ?? (() => new Date());
  }

  public applySignal(signal: DomainRankSignal): Result<void, IndexDbError> {
    const normalized = normalizeDomain(signal.domain);
    if (!normalized.isOk) {
      return ok(undefined);
    }

    const at = this.clock().toISOString();
    const positive = signal.delta === 1 ? 1 : 0;
    const negative = signal.delta === -1 ? 1 : 0;

    try {
      this.db
        .prepare(
          `INSERT INTO domain_ranks
             (domain, rank, positive_signals, negative_signals, origin, first_seen_at, last_signal_at)
           VALUES (?, ?, ?, ?, 'auto', ?, ?)
           ON CONFLICT(domain) DO UPDATE SET
             rank = MAX(?, MIN(?, domain_ranks.rank + excluded.rank)),
             positive_signals = domain_ranks.positive_signals + excluded.positive_signals,
             negative_signals = domain_ranks.negative_signals + excluded.negative_signals,
             last_signal_at = excluded.last_signal_at`,
        )
        .run(normalized.value, signal.delta, positive, negative, at, at, RANK_MIN, RANK_MAX);
      this.logger?.debug(
        { domain: normalized.value, delta: signal.delta, reason: signal.reason },
        'domain rank signal recorded',
      );
      return ok(undefined);
    } catch (error) {
      return err(
        new IndexDbError('failed to apply domain rank signal', {
          op: 'domainRanks.applySignal',
          cause: error,
        }),
      );
    }
  }

  public upsertUserDomain(
    domain: string,
  ): Result<DomainRankRecord, IndexDbError | DomainValidationError> {
    const normalized = normalizeDomain(domain);
    if (!normalized.isOk) {
      return normalized;
    }

    const at = this.clock().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO domain_ranks
             (domain, rank, positive_signals, negative_signals, origin, first_seen_at, last_signal_at)
           VALUES (?, 1, 1, 0, 'user', ?, ?)
           ON CONFLICT(domain) DO UPDATE SET
             rank = MAX(?, MIN(?, domain_ranks.rank + 1)),
             positive_signals = domain_ranks.positive_signals + 1,
             origin = 'user',
             last_signal_at = excluded.last_signal_at`,
        )
        .run(normalized.value, at, at, RANK_MIN, RANK_MAX);

      const record = this.read(normalized.value);
      if (record === null) {
        return err(
          new IndexDbError('failed to read user domain after upsert', {
            op: 'domainRanks.upsertUserDomain',
          }),
        );
      }
      this.logger?.debug({ domain: normalized.value, delta: 1 }, 'user domain ranked');
      return ok(record);
    } catch (error) {
      return err(
        new IndexDbError('failed to upsert user domain', {
          op: 'domainRanks.upsertUserDomain',
          cause: error,
        }),
      );
    }
  }

  public remove(domain: string): Result<boolean, IndexDbError | DomainValidationError> {
    const normalized = normalizeDomain(domain);
    if (!normalized.isOk) {
      return normalized;
    }

    try {
      const result = this.db
        .prepare('DELETE FROM domain_ranks WHERE domain = ?')
        .run(normalized.value);
      return ok(Number(result.changes) > 0);
    } catch (error) {
      return err(
        new IndexDbError('failed to remove domain rank', {
          op: 'domainRanks.remove',
          cause: error,
        }),
      );
    }
  }

  public list(): Result<readonly DomainRankRecord[], IndexDbError> {
    try {
      const rows = this.db
        .prepare(
          `SELECT domain, rank, positive_signals, negative_signals,
                  origin, first_seen_at, last_signal_at
             FROM domain_ranks
            ORDER BY rank DESC, domain ASC`,
        )
        .all() as unknown as DomainRankRow[];
      return ok(rows.map(rowToRecord));
    } catch (error) {
      return err(
        new IndexDbError('failed to list domain ranks', {
          op: 'domainRanks.list',
          cause: error,
        }),
      );
    }
  }

  private read(domain: string): DomainRankRecord | null {
    const row = this.db
      .prepare(
        `SELECT domain, rank, positive_signals, negative_signals,
                origin, first_seen_at, last_signal_at
           FROM domain_ranks
          WHERE domain = ?`,
      )
      .get(domain) as DomainRankRow | undefined;
    return row === undefined ? null : rowToRecord(row);
  }
}

interface DomainRankRow {
  readonly domain: string;
  readonly rank: number;
  readonly positive_signals: number;
  readonly negative_signals: number;
  readonly origin: 'auto' | 'user';
  readonly first_seen_at: string;
  readonly last_signal_at: string;
}

function rowToRecord(row: DomainRankRow): DomainRankRecord {
  return {
    domain: row.domain,
    rank: Number(row.rank),
    positiveSignals: Number(row.positive_signals),
    negativeSignals: Number(row.negative_signals),
    origin: row.origin,
    firstSeenAt: row.first_seen_at,
    lastSignalAt: row.last_signal_at,
  };
}
