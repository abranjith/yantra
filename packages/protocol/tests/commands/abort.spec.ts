// @no-llm
import { describe, expect, it } from 'vitest';

import { ABORT_RULES, abortRule, honorsAbort } from '../../src/commands/abort.js';
import { COMMAND_REGISTRY } from '../../src/commands/registry.js';

const facts = { options: {}, arguments: {} } as const;

describe('abort rules (FEAT-067)', () => {
  it('lists only registry leaves', () => {
    const leaves = new Set(
      COMMAND_REGISTRY.commands.filter((entry) => entry.kind === 'leaf').map((entry) => entry.id),
    );
    expect(Object.keys(ABORT_RULES).filter((id) => !leaves.has(id))).toEqual([]);
  });

  it('treats an unlisted command as never honoring abort', () => {
    expect(abortRule('list')).toBe('never');
    expect(abortRule('toString')).toBe('never');
    expect(honorsAbort('list', facts)).toBe(false);
  });

  it('honors abort for do always, and for run and resume never', () => {
    expect(honorsAbort('do', facts)).toBe(true);
    expect(honorsAbort('run', facts)).toBe(false);
    expect(honorsAbort('resume', facts)).toBe(false);
  });

  it('honors abort for ask and research only in LLM mode', () => {
    expect(honorsAbort('ask', { ...facts, mode: 'llm' })).toBe(true);
    expect(honorsAbort('ask', { ...facts, mode: 'deterministic' })).toBe(false);
    // Without a resolved mode, --no-llm (llm: false) means deterministic.
    expect(honorsAbort('research', { options: { llm: false }, arguments: {} })).toBe(false);
    expect(honorsAbort('research', facts)).toBe(true);
  });

  it('honors abort for doctor only with --agent-smoke', () => {
    expect(honorsAbort('doctor', { options: { agentSmoke: true }, arguments: {} })).toBe(true);
    expect(honorsAbort('doctor', { options: { agentSmoke: false }, arguments: {} })).toBe(false);
    expect(
      honorsAbort('doctor', { options: { agentSmoke: true }, arguments: {}, explicit: [] }),
    ).toBe(false);
  });
});
