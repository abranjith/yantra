import { ResourceBusyError } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import { throwIfResourceBusy } from '../src/resource-busy.js';

describe('@no-llm CLI busy response', () => {
  const holder = {
    pid: 1234,
    command: 'yantra config set',
    started_at: '2026-11-06T12:00:00.000Z',
    surface: 'terminal' as const,
  };

  function output() {
    let stdout = '';
    let stderr = '';
    return {
      stdout: {
        write(value: string | Uint8Array) {
          stdout += String(value);
          return true;
        },
      },
      stderr: {
        write(value: string | Uint8Array) {
          stderr += String(value);
          return true;
        },
      },
      captured: () => ({ stdout, stderr }),
    };
  }

  it('emits the typed JSON envelope and maps contention to environment exit 3', () => {
    const sinks = output();
    const error = new ResourceBusyError({ kind: 'config' }, holder);
    expect(() => throwIfResourceBusy(error, 'config.set', true, sinks)).toThrowError(
      expect.objectContaining({ exitCode: 3, code: 'yantra.resource.busy' }),
    );
    expect(JSON.parse(sinks.captured().stdout)).toEqual({
      schemaVersion: '0.2',
      kind: 'config.set',
      status: 'busy',
      resource: { kind: 'config' },
      holder,
    });
    expect(sinks.captured().stderr).toBe('');
  });

  it('prints holder context and remediation once in human mode', () => {
    const sinks = output();
    const error = new ResourceBusyError({ kind: 'config' }, holder);
    expect(() => throwIfResourceBusy(error, 'model.add', false, sinks)).toThrowError(
      expect.objectContaining({ exitCode: 3 }),
    );
    expect(sinks.captured()).toEqual({
      stdout: '',
      stderr: `${error.message} ${error.remediation}\n`,
    });
  });

  it('does not map non-contention failures to busy', () => {
    const sinks = output();
    expect(
      throwIfResourceBusy(new Error('permission denied'), 'config.set', true, sinks),
    ).toBeUndefined();
    expect(sinks.captured()).toEqual({ stdout: '', stderr: '' });
  });
});
