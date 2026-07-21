import { describe, expect, it } from 'vitest';

import { detectShowTarget } from '../../src/commands/auto-detect.js';

describe('@no-llm cli/auto-detect', () => {
  it('classifies an ISO-prefixed run-id as a run', () => {
    expect(detectShowTarget('20260516T120304Z-bank-statement-a7b3')).toBe('run');
  });

  it('classifies a workflow-name string as a workflow', () => {
    expect(detectShowTarget('bank-statement')).toBe('workflow');
    expect(detectShowTarget('my-flow-2026')).toBe('workflow');
  });

  it('treats partial timestamps (missing trailing dash) as workflow names', () => {
    expect(detectShowTarget('20260516T120304Z')).toBe('workflow');
  });

  it('handles edge cases without throwing', () => {
    expect(detectShowTarget('')).toBe('workflow');
    expect(detectShowTarget('-only-dashes-')).toBe('workflow');
  });
});
