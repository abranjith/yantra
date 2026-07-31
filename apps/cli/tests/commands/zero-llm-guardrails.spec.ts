// @no-llm
/**
 * Hard zero-LLM surfaces (FEAT-FP-001, TASK-009).
 *
 * Two surfaces must never open a provider session no matter how the workflow or
 * environment is configured: scheduled/daemon fires (unattended, so nobody is
 * present to have authorized a model) and nested `workflow_run` invocations (the
 * parent agent session is the run's one model). These are the invariants a future
 * refactor is most likely to break silently, so they are asserted against the
 * wiring source rather than only through behavior.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function read(repoRelativePath: string): string {
  return readFileSync(resolve(repoRoot, repoRelativePath), 'utf8');
}

describe('@no-llm scheduled runs are hard zero-LLM', () => {
  const source = read('apps/cli/src/commands/daemon-runtime.ts');

  it('wires every orchestrator runtime with noLlm: true', () => {
    const calls = source.match(/buildOrchestratorRuntime\(\{[\s\S]*?\n {6}\}\)/g) ?? [];

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).toContain('noLlm: true');
      expect(call).toContain('llm: null');
    }
  });

  it('never constructs a synthesis LLM adapter or provider', () => {
    expect(source).not.toContain('createSynthesisLlm');
    expect(source).not.toContain('PiAgentProvider');
    expect(source).not.toContain('selectAgentSession');
  });
});

describe('@no-llm nested workflow_run is hard zero-LLM', () => {
  const source = read('packages/agent/src/runtime/orchestrator.ts');

  it('constructs the nested RunOrchestrator with synthesis disabled', () => {
    // `synthesis: null` (rather than a deterministic stage) also means the nested
    // run writes no Brief of its own — the agent publishes the result.
    const nested = /workflow: \{[\s\S]*?new RunOrchestrator\(\{[\s\S]*?\}\)/.exec(source)?.[0];

    expect(nested).toBeDefined();
    expect(nested).toContain('synthesis: null');
  });

  it('never wires a synthesis LLM into a nested replay', () => {
    expect(source).not.toContain('createSynthesisLlm');
    expect(source).not.toContain('LlmSynthesizer');
  });
});

describe('@no-llm the interactive run path is workflow-declared only', () => {
  const source = read('apps/cli/src/commands/run.ts');

  it('gates the provider adapter behind a resolved selection', () => {
    // The adapter is constructed inside the `selection === null ? null : ...`
    // branch, so `--no-llm` cannot reach it.
    expect(source).toContain('selection === null');
    expect(source).toContain('createSynthesisLlm');
  });

  it('offers --no-llm as a veto and no --llm opt-in', () => {
    expect(source).toContain("'--no-llm'");
    expect(source).not.toMatch(/new Option\(\s*'--llm'/);
  });
});

describe('@no-llm the synthesize stage never opts a workflow in', () => {
  const source = read('packages/core/src/workflow/replay/synthesize.ts');

  it('requires the workflow to have declared use_llm', () => {
    // Both halves are load-bearing: a caller-supplied port alone must never be
    // enough, or `--model` would quietly turn every replay into a model run.
    expect(source).toContain('opts.spec.useLlm && !opts.strategies.noLlm');
  });
});
