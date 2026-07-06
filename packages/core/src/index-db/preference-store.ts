/**
 * `PreferenceStore` — the machine-managed `preferences` table plus the merge
 * with the human `profile.yaml` layer into an {@link EffectivePreferences} view.
 *
 * Two provenances, three precedence tiers (highest wins):
 *   1. explicit `prefs set` rows (`source='user'` in the DB),
 *   2. `profile.yaml` values (the human-editable layer),
 *   3. machine `learned` rows (`source='learned'`).
 *
 * This satisfies the spec's "yaml `user` keys win over DB `learned` keys" rule
 * while still letting an explicit `prefs set` override a yaml default. Only
 * `approved` values may later feed the personalization context (privacy gate,
 * enforced in TASK-004); `forget` deletes a row outright (real deletion).
 */

import { err, ok, type Result } from '@yantra/protocol';

import type { Logger } from '../browser/types.js';
import type {
  EffectivePreference,
  EffectivePreferences,
  PreferenceSourceKind,
} from '../profile/effective-preferences.js';

import type { DatabaseSync } from './sqlite.js';
import { IndexDbError } from './types.js';

/** One row of the `preferences` table (value decoded from JSON). */
export interface PreferenceRecord {
  readonly key: string;
  readonly value: unknown;
  readonly source: PreferenceSourceKind;
  readonly approved: boolean;
  readonly updatedAt: string;
}

/** Options for {@link PreferenceStore.set}. */
export interface SetPreferenceOptions {
  /** `user` (default) is approved-by-definition; `learned` starts unapproved. */
  readonly source?: PreferenceSourceKind;
  /** Explicit approval override; defaults to `true` for `user`, `false` for `learned`. */
  readonly approved?: boolean;
}

/** Repository interface over the `preferences` table + yaml merge. */
export interface PreferenceStore {
  /** Reads one preference row, or null when absent. */
  get(key: string): Promise<Result<PreferenceRecord | null, IndexDbError>>;
  /** Upserts a preference value (JSON-encoded). */
  set(
    key: string,
    value: unknown,
    opts?: SetPreferenceOptions,
  ): Promise<Result<void, IndexDbError>>;
  /** Lists all preference rows (ascending by key). */
  list(): Promise<Result<readonly PreferenceRecord[], IndexDbError>>;
  /** Deletes a preference row (privacy control). Returns whether a row existed. */
  forget(key: string): Promise<Result<boolean, IndexDbError>>;
  /** Marks a `learned` row approved so it may enter personalization. */
  approve(key: string): Promise<Result<boolean, IndexDbError>>;
  /**
   * Merges the DB rows with the supplied `profile.yaml` layer into the final
   * effective view. The yaml layer is passed in (flattened) so this store never
   * touches the filesystem.
   */
  effective(
    yamlLayer: ReadonlyMap<string, unknown>,
  ): Promise<Result<EffectivePreferences, IndexDbError>>;
}

/** Constructor dependencies for {@link SqlitePreferenceStore}. */
export interface SqlitePreferenceStoreDeps {
  readonly db: DatabaseSync;
  readonly logger?: Logger;
  /** Injected clock for deterministic `updated_at` in tests. */
  readonly clock?: () => Date;
}

/** SQLite-backed {@link PreferenceStore}. */
export class SqlitePreferenceStore implements PreferenceStore {
  private readonly db: DatabaseSync;
  private readonly logger: Logger | null;
  private readonly clock: () => Date;

  public constructor(deps: SqlitePreferenceStoreDeps) {
    this.db = deps.db;
    this.logger = deps.logger ?? null;
    this.clock = deps.clock ?? (() => new Date());
  }

  public get(key: string): Promise<Result<PreferenceRecord | null, IndexDbError>> {
    try {
      const row = this.db
        .prepare('SELECT key, value, source, approved, updated_at FROM preferences WHERE key = ?')
        .get(key) as PreferenceRow | undefined;
      return Promise.resolve(ok(row === undefined ? null : rowToRecord(row)));
    } catch (error) {
      return Promise.resolve(
        err(new IndexDbError('failed to read preference', { op: 'preferences.get', cause: error })),
      );
    }
  }

  public set(
    key: string,
    value: unknown,
    opts: SetPreferenceOptions = {},
  ): Promise<Result<void, IndexDbError>> {
    const source: PreferenceSourceKind = opts.source ?? 'user';
    const approved = opts.approved ?? source === 'user';
    try {
      this.db
        .prepare(
          `INSERT INTO preferences (key, value, source, approved, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             source = excluded.source,
             approved = excluded.approved,
             updated_at = excluded.updated_at`,
        )
        .run(key, JSON.stringify(value), source, approved ? 1 : 0, this.clock().toISOString());
      // Log the key only — never the value, which may be personal (§Logging).
      this.logger?.info?.({ key, source }, 'preference set');
      return Promise.resolve(ok(undefined));
    } catch (error) {
      return Promise.resolve(
        err(new IndexDbError('failed to set preference', { op: 'preferences.set', cause: error })),
      );
    }
  }

  public list(): Promise<Result<readonly PreferenceRecord[], IndexDbError>> {
    try {
      const rows = this.db
        .prepare(
          'SELECT key, value, source, approved, updated_at FROM preferences ORDER BY key ASC',
        )
        .all() as unknown as PreferenceRow[];
      return Promise.resolve(ok(rows.map(rowToRecord)));
    } catch (error) {
      return Promise.resolve(
        err(
          new IndexDbError('failed to list preferences', { op: 'preferences.list', cause: error }),
        ),
      );
    }
  }

  public forget(key: string): Promise<Result<boolean, IndexDbError>> {
    try {
      const result = this.db.prepare('DELETE FROM preferences WHERE key = ?').run(key);
      const removed = Number(result.changes) > 0;
      if (removed) {
        this.logger?.info?.({ key }, 'preference forgotten');
      }
      return Promise.resolve(ok(removed));
    } catch (error) {
      return Promise.resolve(
        err(
          new IndexDbError('failed to forget preference', {
            op: 'preferences.forget',
            cause: error,
          }),
        ),
      );
    }
  }

  public approve(key: string): Promise<Result<boolean, IndexDbError>> {
    try {
      const result = this.db
        .prepare('UPDATE preferences SET approved = 1, updated_at = ? WHERE key = ?')
        .run(this.clock().toISOString(), key);
      const approved = Number(result.changes) > 0;
      if (approved) {
        this.logger?.info?.({ key }, 'preference approved');
      }
      return Promise.resolve(ok(approved));
    } catch (error) {
      return Promise.resolve(
        err(
          new IndexDbError('failed to approve preference', {
            op: 'preferences.approve',
            cause: error,
          }),
        ),
      );
    }
  }

  public async effective(
    yamlLayer: ReadonlyMap<string, unknown>,
  ): Promise<Result<EffectivePreferences, IndexDbError>> {
    const rowsResult = await this.list();
    if (!rowsResult.isOk) {
      return rowsResult;
    }

    const merged = new Map<string, EffectivePreference>();

    // Tier 3 (lowest): machine-learned DB rows.
    for (const row of rowsResult.value) {
      if (row.source === 'learned') {
        merged.set(row.key, {
          key: row.key,
          value: row.value,
          source: 'learned',
          approved: row.approved,
          provenance: 'index.db',
        });
      }
    }

    // Tier 2: profile.yaml (user layer, always approved).
    for (const [key, value] of yamlLayer) {
      merged.set(key, { key, value, source: 'user', approved: true, provenance: 'profile.yaml' });
    }

    // Tier 1 (highest): explicit `prefs set` user rows.
    for (const row of rowsResult.value) {
      if (row.source === 'user') {
        merged.set(row.key, {
          key: row.key,
          value: row.value,
          source: 'user',
          approved: row.approved,
          provenance: 'index.db',
        });
      }
    }

    return ok(merged);
  }
}

/** Raw `preferences` row shape from node:sqlite. */
interface PreferenceRow {
  readonly key: string;
  readonly value: string;
  readonly source: PreferenceSourceKind;
  readonly approved: number;
  readonly updated_at: string;
}

function rowToRecord(row: PreferenceRow): PreferenceRecord {
  return {
    key: row.key,
    value: decodeJson(row.value),
    source: row.source,
    approved: Number(row.approved) === 1,
    updatedAt: row.updated_at,
  };
}

function decodeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // A hand-edited DB could hold a bare string — return it verbatim.
    return raw;
  }
}
