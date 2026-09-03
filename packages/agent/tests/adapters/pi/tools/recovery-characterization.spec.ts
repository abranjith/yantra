/** @no-llm complete-agent-seam recovery characterization gate. */

import { describe, expect, it } from 'vitest';

import { CLICK_RECOVERY_BUDGET_MS } from '../../../../src/adapters/pi/tools/browser-click.js';
import { driveWithRetry } from '../../../../src/adapters/pi/tools/browser-fill-element.js';

describe('@no-llm agent recovery characterization gate', () => {
  it('keeps the outer fill recovery seam exported until its declarative migration', () => {
    expect(typeof driveWithRetry).toBe('function');
  });

  it('pins the click recovery deadline independently of the runner migration', () => {
    expect(CLICK_RECOVERY_BUDGET_MS).toBe(15_000);
  });
});
