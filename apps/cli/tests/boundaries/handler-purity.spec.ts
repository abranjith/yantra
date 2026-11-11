import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

// @ts-expect-error Repository JS exports intentionally have no declarations.
import { HANDLER_PURITY_SELECTORS } from '../../../../eslint.config.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const eslint = new ESLint({ cwd: root, overrideConfig: [tseslint.configs.disableTypeChecked] });
describe('@no-llm handler purity boundary', () => {
  it('pins every forbidden capability and retains the site tripwire', async () => {
    const [result] = await new ESLint({
      cwd: root,
      ignore: false,
      overrideConfig: [tseslint.configs.disableTypeChecked],
    }).lintFiles(['apps/cli/src/adapters/terminal/_lint-fixtures/impure-handler.ts']);
    const violations = result!.messages.filter((m) => m.ruleId === 'no-restricted-syntax');
    for (const rule of HANDLER_PURITY_SELECTORS)
      expect(violations.some((m) => m.message === rule.message)).toBe(true);
    expect(violations.some((m) => m.message.includes('Website-specific'))).toBe(true);
  });
  it('enforces every handler and helper without a migration allowlist', async () => {
    expect(
      await readFile(new URL('../../../../eslint.config.js', import.meta.url), 'utf8'),
    ).not.toContain('HANDLER_PURITY_MIGRATION_ALLOWLIST');
    const results = await eslint.lintFiles(['apps/cli/src/**/*.ts']);
    const violations = results
      .filter((r) => !r.filePath.includes('_lint-fixtures'))
      .flatMap((r) =>
        r.messages
          .filter((m) => m.ruleId === 'no-restricted-syntax')
          .map((m) => `${r.filePath}: ${m.message}`),
      );
    expect(violations).toEqual([]);
    const helpers = results.filter((result) => {
      const path = result.filePath.replaceAll('\\', '/');
      // Process entry points own the process: the terminal adapter, the bin,
      // and the detached worker and its trampoline (FEAT-064).
      return (
        !path.includes('/adapters/terminal/') &&
        !path.endsWith('/bin.ts') &&
        !path.endsWith('/src/worker.ts') &&
        !path.endsWith('/worker/trampoline.ts')
      );
    });
    const leaks = await Promise.all(
      helpers.map(async (result) => ({
        path: result.filePath,
        text: await readFile(result.filePath, 'utf8'),
      })),
    );
    expect(
      leaks
        .filter(({ text }) =>
          /process\.(exit|stdin|stdout|stderr)|isTTY|new CLIConnectorIO/u.test(text),
        )
        .map(({ path }) => path),
    ).toEqual([]);
  }, 30_000);
});
