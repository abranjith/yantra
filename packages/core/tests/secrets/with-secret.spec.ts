import { describe, expect, it, vi } from 'vitest';

import { withSecret } from '../../src/secrets/with-secret.js';

describe('@no-llm withSecret', () => {
  it('zeros the temporary buffer after successful callback execution', async () => {
    const fillSpy = vi.spyOn(Buffer.prototype, 'fill');

    const result = await withSecret('super-secret', async (value) => {
      expect(value).toBe('super-secret');
      return 'done';
    });

    expect(result).toBe('done');
    expect(fillSpy).toHaveBeenCalled();

    fillSpy.mockRestore();
  });

  it('zeros the temporary buffer even when callback throws', async () => {
    const fillSpy = vi.spyOn(Buffer.prototype, 'fill');

    await expect(
      withSecret('super-secret', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(fillSpy).toHaveBeenCalled();

    fillSpy.mockRestore();
  });
});
