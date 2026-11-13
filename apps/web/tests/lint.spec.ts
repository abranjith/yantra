// @no-llm
/**
 * The app passes Drshya's styling and import rules (FEAT-065 TASK-011): no
 * raw colors, icons only through the registry, browser-only imports.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('apps/web lint', () => {
  it('has no lint problem in src', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const results = await eslint.lintFiles([resolve(repoRoot, 'apps/web/src')]);
    const problems = results.flatMap((result) =>
      result.messages.map(
        (message) =>
          `${result.filePath}:${message.line} ${message.ruleId ?? ''} ${message.message}`,
      ),
    );
    expect(problems).toEqual([]);
  }, 60_000);

  it.each([
    ['a raw palette utility', "export const c = 'text-red-500';", 'no-restricted-syntax'],
    ['a hex color', "export const c = '#ff0000';", 'no-restricted-syntax'],
    [
      'a direct lucide-react import',
      "import { X } from 'lucide-react';\nexport const c = X;",
      '@typescript-eslint/no-restricted-imports',
    ],
    [
      'a Node built-in',
      "import { readFileSync } from 'node:fs';\nexport const c = readFileSync;",
      'import/no-nodejs-modules',
    ],
    [
      'a runtime protocol import',
      "import { ReadParams } from '@yantra/protocol';\nexport const c = ReadParams;",
      '@typescript-eslint/no-restricted-imports',
    ],
  ])(
    'flags %s in apps/web',
    async (_label, code, ruleId) => {
      const eslint = new ESLint({
        cwd: repoRoot,
        overrideConfig: tseslint.configs.disableTypeChecked,
      });
      const [result] = await eslint.lintText(code, {
        filePath: resolve(repoRoot, 'apps/web/src/probe.tsx'),
      });
      expect(result?.messages.map((message) => message.ruleId)).toContain(ruleId);
    },
    60_000,
  );
});
