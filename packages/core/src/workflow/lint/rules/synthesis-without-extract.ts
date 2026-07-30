import type { WorkflowFile } from '@yantra/protocol';

import type { LintFinding, LintRule } from '../index.js';

/**
 * Warns when a workflow declares `synthesis:` but has no `extract` step.
 *
 * The Synthesize stage builds the Brief's sources from the provenance that
 * `extract` steps record, so a synthesis block with nothing to read produces a
 * sourceless Brief — technically valid, practically empty.
 *
 * A **warning**, not an error: the block is still legal, the run still succeeds,
 * and an author mid-edit (synthesis declared, extract step next) must not be
 * blocked from saving.
 */
export const synthesisWithoutExtract: LintRule = {
  name: 'SynthesisWithoutExtract',
  check(workflow: WorkflowFile): LintFinding[] {
    if (workflow.synthesis === null) return [];

    const hasExtract = workflow.steps.some((step) => step.verb === 'extract');
    if (hasExtract) return [];

    return [
      {
        code: 'SynthesisWithoutExtract',
        severity: 'warning',
        path: 'synthesis',
        message:
          'synthesis is declared but this workflow has no extract step, so the Brief would have no sources to cite.',
        suggestion:
          'Add an extract step for the page the Brief should summarize, or remove the synthesis block.',
      },
    ];
  },
};
