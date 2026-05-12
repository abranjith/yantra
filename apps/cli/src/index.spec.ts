import { describe, expect, it, vi } from 'vitest';

import { run } from './index.js';

describe('@no-llm cli smoke', () => {
  it('prints a single-line protocol banner when invoked', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    run();

    expect(logSpy).toHaveBeenCalledOnce();
    const message = (logSpy.mock.calls[0]?.[0] as string | undefined) ?? '';
    expect(message).toContain('yantra');
    expect(message).toContain('protocol=0.0.0');
    expect(message).toContain('core=0.0.0');
    expect(message).toContain('agent=0.0.0');

    logSpy.mockRestore();
  });
});
