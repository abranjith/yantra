import { describe, expect, it, vi } from 'vitest';

import { wireTerminalSignals } from '../../src/adapters/terminal/terminal-adapter.js';
describe('@no-llm terminal signal boundary', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'aborts supporting handlers and disposes %s',
    (signal) => {
      const controller = new AbortController();
      const exit = vi.fn();
      const before = process.listenerCount(signal);
      const dispose = wireTerminalSignals(controller, () => true, exit);
      try {
        process.emit(signal);
        expect(controller.signal.aborted).toBe(true);
        expect(controller.signal.reason).toBe(signal);
        expect(exit).not.toHaveBeenCalled();
      } finally {
        dispose();
      }
      expect(process.listenerCount(signal)).toBe(before);
    },
  );
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('retains conventional %s exit for an unsupported handler', (signal, code) => {
    const controller = new AbortController();
    const exit = vi.fn();
    const dispose = wireTerminalSignals(controller, () => false, exit);
    try {
      process.emit(signal);
      expect(exit).toHaveBeenCalledWith(code);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      dispose();
    }
  });
});
