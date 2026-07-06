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

  it('flags rendering-toolchain imports reachable from a --json entrypoint', async () => {
    const report = await runStaticCheck({
      repoRoot,
      roots: ['scripts/__fixtures__/json-violation'],
      jsonPathEntries: ['scripts/__fixtures__/json-violation/entry.ts'],
    });

    expect(report.renderingImportViolations.length).toBe(1);
    expect(report.renderingImportViolations[0]?.importPath).toBe('chalk');
    expect(report.renderingImportViolations[0]?.file).toBe(
      'scripts/__fixtures__/json-violation/styler.ts',
    );
    expect(report.passed).toBe(false);
  });

  it('passes when the --json entrypoint closure imports no rendering deps', async () => {
    const report = await runStaticCheck({
      repoRoot,
      roots: ['scripts/__fixtures__/json-clean'],
      jsonPathEntries: ['scripts/__fixtures__/json-clean/entry.ts'],
    });

    expect(report.renderingImportViolations).toHaveLength(0);
  });

  it('keeps the real --json render path free of the rendering toolchain', async () => {
    const report = await runStaticCheck({
      repoRoot,
      roots: ['apps/cli/src/render'],
    });

    expect(report.renderingImportViolations).toHaveLength(0);
  });

  it('flags an index-db (history) import reachable from an LLM-payload entrypoint', async () => {
    const report = await runStaticCheck({
      repoRoot,
      roots: ['scripts/__fixtures__/history-violation'],
      llmPayloadEntries: ['scripts/__fixtures__/history-violation/entry.ts'],
    });

    expect(report.historyImportViolations.length).toBe(1);
    expect(report.historyImportViolations[0]?.file).toBe(
      'scripts/__fixtures__/history-violation/assembler.ts',
    );
    expect(report.passed).toBe(false);
  });

  it('passes when the LLM-payload closure touches preferences only (no history)', async () => {
    const report = await runStaticCheck({
      repoRoot,
      roots: ['scripts/__fixtures__/history-clean'],
      llmPayloadEntries: ['scripts/__fixtures__/history-clean/entry.ts'],
    });

    expect(report.historyImportViolations).toHaveLength(0);
  });

  it('keeps the real synthesis/query-gen/prompt paths free of index-db imports', async () => {
    const report = await runStaticCheck({
      repoRoot,
      roots: ['packages/core/src/synthesis'],
    });

    expect(report.historyImportViolations).toHaveLength(0);
  });
});
