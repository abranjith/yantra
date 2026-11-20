import { COMMAND_REGISTRY } from '@yantra/protocol/commands';
import { describe, expect, it, vi } from 'vitest';

import { executePalette } from '../../src/palette/execute.js';
import { interpret } from '../../src/palette/palette-model.js';
import { PARITY_MANIFEST } from '../../src/parity/manifest.js';

describe('@no-llm command palette model', () => {
  it('interprets a ready command and notices --json', () => {
    expect(
      interpret('yantra sites add example.com --json', 'posix', COMMAND_REGISTRY, PARITY_MANIFEST),
    ).toMatchObject({
      state: 'ready',
      command: 'sites add',
      notices: ['The app shows structured results itself.'],
    });
  });
  it('refuses operators and suggests misspellings', () => {
    expect(interpret('ls | x', 'posix', COMMAND_REGISTRY, PARITY_MANIFEST)).toMatchObject({
      state: 'refused_syntax',
      reason: 'shell_operator',
    });
    const unknown = interpret('confg set x y', 'posix', COMMAND_REGISTRY, PARITY_MANIFEST);
    expect(unknown.state).toBe('unknown_command');
    if (unknown.state === 'unknown_command') expect(unknown.suggestions).toContain('config set');
  });
  it('never returns a secret value and refuses secret set <key> <value> with the CLI argv message', () => {
    const value = 'canary-secret';
    const outcome = interpret(
      `secret set foo ${value}`,
      'posix',
      COMMAND_REGISTRY,
      PARITY_MANIFEST,
    );
    expect(outcome).toMatchObject({
      state: 'secret_in_argv',
      command: 'secret set',
      message:
        'secret values are never accepted in argv because shell history and process listings can expose them',
    });
    expect(JSON.stringify(outcome)).not.toContain(value);
  });
  it('routes secret set <key> to Credentials with key prefilled without invoking a worker', async () => {
    const outcome = interpret('secret set foo', 'posix', COMMAND_REGISTRY, PARITY_MANIFEST);
    expect(outcome.state).toBe('ready');
    const navigate = vi.fn();
    const request = vi.fn();
    await executePalette(outcome, {
      rpc: { request } as never,
      navigate,
    });
    expect(navigate).toHaveBeenCalledWith('/settings/credentials?key=foo');
    expect(request).not.toHaveBeenCalled();
  });
  it('routes init, init --reset, and doctor to their surfaces while doctor --agent-smoke invokes a worker', async () => {
    const navigate = vi.fn();
    const request = vi.fn().mockResolvedValue({});
    const executor = { rpc: { request } as never, navigate };

    await executePalette(interpret('init', 'posix', COMMAND_REGISTRY, PARITY_MANIFEST), executor);
    await executePalette(
      interpret('init --reset', 'posix', COMMAND_REGISTRY, PARITY_MANIFEST),
      executor,
    );
    await executePalette(interpret('doctor', 'posix', COMMAND_REGISTRY, PARITY_MANIFEST), executor);
    expect(navigate).toHaveBeenNthCalledWith(1, '/onboarding');
    expect(navigate).toHaveBeenNthCalledWith(2, '/onboarding?reset=1');
    expect(navigate).toHaveBeenNthCalledWith(3, '/health');
    expect(request).not.toHaveBeenCalled();

    await executePalette(
      interpret('doctor --agent-smoke', 'posix', COMMAND_REGISTRY, PARITY_MANIFEST),
      executor,
    );
    expect(request).toHaveBeenCalledWith('command.invoke', expect.anything());
  });
  it('reports an unknown option where it exists', () => {
    const unknown = interpret('ask x --no-browse', 'posix', COMMAND_REGISTRY, PARITY_MANIFEST);
    expect(unknown.state).toBe('unknown_option');
    if (unknown.state === 'unknown_option') expect(unknown.registeredOn).toContain('research');
  });
});
