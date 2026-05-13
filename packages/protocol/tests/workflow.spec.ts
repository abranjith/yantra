import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { WorkflowFile } from '../src/index.js';

import { makeWorkflow } from './factories.js';

describe('@no-llm workflow schema', () => {
  it('applies defaults for optional fields', () => {
    const parsed = WorkflowFile.parse({
      version: 1,
      name: 'example',
      description: null,
      security_class: 'public',
      steps: [
        {
          id: 's1',
          scope: null,
          verb: 'navigate',
          url: 'https://example.com',
        },
      ],
    });

    expect(parsed.outputs_unredacted).toBe(false);
    expect(parsed._unrecorded_frames).toEqual([]);
    expect(parsed.recorded_with).toBeNull();
  });

  it('parses a hand-written bank statement workflow fixture', () => {
    expect(WorkflowFile.safeParse(makeWorkflow()).success).toBe(true);
  });

  it('accepts recorded_with null and populated object', () => {
    fc.assert(
      fc.property(fc.boolean(), (includeRecordedWith) => {
        const workflow = makeWorkflow({
          recorded_with: includeRecordedWith
            ? { chrome_major: 124, yantra_version: '0.1.0' }
            : null,
        });

        expect(WorkflowFile.safeParse(workflow).success).toBe(true);
      }),
      { numRuns: 50 },
    );
  });
});
