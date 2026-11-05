// Intentional boundary violation, loaded only by
// `packages/ui/tests/boundary-rules.spec.ts`: Drshya is browser code and must
// not import Node built-ins, with or without the `node:` prefix
// (plan_ui.md §8 "Dependency direction"). Excluded from the build and from
// normal lint runs by the `_lint-fixtures` ignore in `eslint.config.js`.
import { readFile } from 'node:fs/promises';
import path from 'path';

export const fixtureValue = [readFile, path];
