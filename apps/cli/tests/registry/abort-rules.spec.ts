// @no-llm
/**
 * Every handler's `honorsAbort` agrees with the protocol's ABORT_RULES, the
 * one rule the app's Stop wording reads (FEAT-067 TASK-008).
 */

import { ABORT_RULES, COMMAND_REGISTRY, abortRule, honorsAbort } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { buildHandlers } from '../../src/registry/handlers.js';

const LEAVES = COMMAND_REGISTRY.commands
  .filter((entry) => entry.kind === 'leaf')
  .map((entry) => entry.id);

function binding(id: string): object {
  const handlers = buildHandlers() as Readonly<Record<string, unknown>>;
  const value = handlers[id];
  if (typeof value !== 'function') throw new Error(`no handler for ${id}`);
  return value;
}

describe('@no-llm abort rules', () => {
  it('names only registry leaves', () => {
    expect(Object.keys(ABORT_RULES).filter((id) => !LEAVES.includes(id))).toEqual([]);
  });

  it.each(LEAVES)('%s: the handler binding agrees with the rule', (id) => {
    const rule = abortRule(id);
    const handler = binding(id);
    const descriptor = Object.getOwnPropertyDescriptor(handler, 'honorsAbort');

    if (rule === 'always') {
      expect(descriptor?.get).toBeUndefined();
      expect((handler as { honorsAbort?: unknown }).honorsAbort).toBe(true);
    } else if (rule === 'never') {
      expect((handler as { honorsAbort?: unknown }).honorsAbort).not.toBe(true);
    } else {
      // Decided per invocation, through honorsAbort(); false until the handler runs.
      expect(typeof descriptor?.get).toBe('function');
      expect((handler as { honorsAbort?: unknown }).honorsAbort).toBe(false);
    }
  });

  it('decides the per-invocation rules from the invocation', () => {
    expect(honorsAbort('ask', { options: {}, arguments: {}, mode: 'llm' })).toBe(true);
    expect(honorsAbort('ask', { options: { llm: false }, arguments: {} })).toBe(false);
    expect(honorsAbort('research', { options: {}, arguments: {}, mode: 'deterministic' })).toBe(
      false,
    );
    expect(honorsAbort('doctor', { options: { agentSmoke: true }, arguments: {} })).toBe(true);
    expect(honorsAbort('doctor', { options: {}, arguments: {} })).toBe(false);
    expect(honorsAbort('do', { options: {}, arguments: {} })).toBe(true);
    expect(honorsAbort('run', { options: {}, arguments: {} })).toBe(false);
    expect(honorsAbort('list', { options: {}, arguments: {} })).toBe(false);
  });
});
