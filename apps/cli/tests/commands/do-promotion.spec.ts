import { describe, expect, it } from 'vitest';

import { promotionLine } from '../../src/commands/do.js';

describe('@no-llm yantra do --save-as lines (FEAT-054 D5)', () => {
  it('reports a plain save with its replay command', () => {
    expect(promotionLine({ saved: true, workflowName: 'form-fill', omitted: [] })).toBe(
      '✓ Saved workflow "form-fill". Replay it with: yantra run form-fill\n',
    );
  });

  it('names a fulfilled item the workflow was saved without', () => {
    expect(
      promotionLine({ saved: true, workflowName: 'form-fill', omitted: ['viewport screenshot'] }),
    ).toBe(
      '✓ Saved workflow "form-fill" without its viewport screenshot step (no replay step captures a screenshot yet). Replay it with: yantra run form-fill\n',
    );
    expect(
      promotionLine({
        saved: true,
        workflowName: 'form-fill',
        omitted: ['viewport screenshot', 'full-page screenshot'],
      }),
    ).toContain('without its viewport screenshot and full-page screenshot step');
  });

  it('keeps the warning form for a run that was not saved', () => {
    expect(
      promotionLine({
        saved: false,
        workflowName: 'form-fill',
        error:
          'Not saved: the run was partial (2 of 4 requirements met). Only a fulfilled run is saved as a workflow.',
      }),
    ).toBe(
      '⚠ Could not save workflow "form-fill": Not saved: the run was partial (2 of 4 requirements met). Only a fulfilled run is saved as a workflow.\n',
    );
  });
});
