/**
 * Local SQLite index (`~/.yantra/data/index.db`) — a rebuildable cache
 * over the canonical run-dir files (plan §7). Houses the `HistoryStore`,
 * `PreferenceStore`, and `RateLimitStore` repository abstractions.
 */

export {
  IN_MEMORY_PATH,
  indexDbPath,
  openIndexDb,
  getMeta,
  setMeta,
  type IndexRebuildHook,
  type OpenIndexDbOptions,
  type OpenIndexDbResult,
} from './db.js';
export {
  MIGRATIONS,
  SCHEMA_VERSION,
  currentSchemaVersion,
  runMigrations,
  type Migration,
} from './migrations.js';
export { IndexDbError, type HistoryStatus, type TaskType } from './types.js';
export {
  SqliteHistoryStore,
  deriveHistoryEntry,
  type HistoryEntry,
  type HistoryListFilter,
  type HistoryStore,
  type SqliteHistoryStoreDeps,
  type UsageRollupFilter,
  type UsageRollupRow,
} from './history-store.js';
export {
  SqlitePreferenceStore,
  type PreferenceRecord,
  type PreferenceStore,
  type SetPreferenceOptions,
  type SqlitePreferenceStoreDeps,
} from './preference-store.js';
export {
  SqliteRateLimitStore,
  type RateLimitState,
  type RateLimitStore,
  type SqliteRateLimitStoreDeps,
} from './rate-limit-store.js';
export {
  SqliteScheduleStore,
  type LastFireStatus,
  type MarkFireInput,
  type NotifyTarget,
  type OnConfirmPolicy,
  type RegisterScheduleInput,
  type Schedule,
  type ScheduleStore,
  type SqliteScheduleStoreDeps,
} from './schedule-store.js';
export {
  RANK_MAX,
  RANK_MIN,
  SqliteDomainRankStore,
  type DomainRankRecord,
  type DomainRankStore,
  type SqliteDomainRankStoreDeps,
} from './domain-rank-store.js';
