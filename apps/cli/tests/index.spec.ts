import { describe, expect, it, vi } from 'vitest';

import { run } from '../src/index.js';

describe('@no-llm cli smoke', () => {
  it('prints a single-line protocol banner when invoked with no arguments', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const exitCode = await run([]);

    expect(writeSpy).toHaveBeenCalled();
    const message = (writeSpy.mock.calls[0]?.[0] as string | undefined) ?? '';
    expect(message).toContain('yantra');
    expect(message).toContain('protocol=0.0.0');
    expect(message).toContain('core=0.0.0');
    expect(message).toContain('agent=0.0.0');
    expect(exitCode).toBe(0);

    writeSpy.mockRestore();
  });
});
