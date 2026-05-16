import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runStaticCheck } from '../../../../scripts/ci-static-check.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('@no-llm ci static check script', () => {
  it('flags LLMClient.send calls missing prior sanitize()', async () => {
    const report = await runStaticCheck({
      repoRoot,
      roots: ['scripts/__fixtures__/forgot'],
    });

    expect(report.passed).toBe(false);
    expect(report.violations.length).toBeGreaterThan(0);
  });

  it('passes when send call is sanitized in the same function scope', async () => {
    const report = await runStaticCheck({
      repoRoot,
      roots: ['scripts/__fixtures__/correct'],
    });

    expect(report.violations).toHaveLength(0);
  });

  it('flags pi-agent-core imports outside packages/agent', async () => {
    const report = await runStaticCheck({
      repoRoot,
      roots: ['scripts/__fixtures__/invalid-import'],
    });

    expect(report.restrictedImportViolations.length).toBe(1);
    expect(report.passed).toBe(false);
  });
});
