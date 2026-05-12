import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const lintMessagesFor = async (filePath: string) => {
  const eslint = new ESLint({
    cwd: repoRoot,
    ignore: false,
  });

  const results = await eslint.lintFiles([filePath]);
  return results.flatMap((result) => result.messages);
};

describe('@no-llm lint boundary rules', () => {
  it('rejects @yantra/core imports from packages/agent', async () => {
    const fixturePath = resolve(
      repoRoot,
      'packages/agent/src/_lint-fixtures/agent-imports-core.ts',
    );

    const messages = await lintMessagesFor(fixturePath);
    const restricted = messages.filter((message) => message.ruleId === 'no-restricted-imports');

    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.message).toContain('must not import from @yantra/core');
  });

  it('rejects pi-agent-core imports outside packages/agent', async () => {
    const fixturePath = resolve(
      repoRoot,
      'packages/core/src/_lint-fixtures/core-imports-pi-agent-core.ts',
    );

    const messages = await lintMessagesFor(fixturePath);
    const restricted = messages.filter((message) => message.ruleId === 'no-restricted-imports');

    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.message).toContain(
      'Direct pi-agent-core imports are forbidden outside packages/agent',
    );
  });
});
