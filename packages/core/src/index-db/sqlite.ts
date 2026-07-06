/**
 * Thin loader for Node's built-in `node:sqlite` engine.
 *
 * `node:sqlite` is a genuine builtin (`module.isBuiltin('node:sqlite')` is
 * true) but is deliberately hidden from the enumerable `builtinModules` list
 * while it is experimental. Bundlers/test-runners that externalize by scanning
 * that list (Vite / vite-node) therefore mis-handle a static
 * `import ... from 'node:sqlite'`, normalizing it to a bare `sqlite` specifier
 * they cannot resolve.
 *
 * Loading it through `createRequire` sidesteps static import analysis entirely
 * — the same escape hatch other tools use for conditional native builtins —
 * so the engine loads natively under `node`, `tsx`, and `vitest` alike. Types
 * are still imported with `import type` (fully erased, never resolved at
 * runtime), preserving full type-safety.
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);

/** The subset of the `node:sqlite` module surface this project uses. */
interface SqliteModuleShape {
  readonly DatabaseSync: new (path: string, options?: object) => DatabaseSyncType;
}

// The specifier is assembled so neither esbuild nor Vite rewrites it into a
// static import during transform.
const SQLITE_MODULE = ['node', 'sqlite'].join(':');
const sqliteModule = nodeRequire(SQLITE_MODULE) as SqliteModuleShape;

/** Node's synchronous SQLite database constructor. */
export const DatabaseSync = sqliteModule.DatabaseSync;

/** The `DatabaseSync` instance type (re-exported for annotations). */
export type DatabaseSync = DatabaseSyncType;
