import { COMMAND_REGISTRY } from '@yantra/protocol/commands';
import { describe, expect, it } from 'vitest';

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
  it('never returns a secret value', () => {
    const value = 'canary-secret';
    const outcome = interpret(`secret set k ${value}`, 'posix', COMMAND_REGISTRY, PARITY_MANIFEST);
    expect(outcome).toMatchObject({ state: 'secret_in_argv' });
    expect(JSON.stringify(outcome)).not.toContain(value);
  });
  it('reports an unknown option where it exists', () => {
    const unknown = interpret('ask x --no-browse', 'posix', COMMAND_REGISTRY, PARITY_MANIFEST);
    expect(unknown.state).toBe('unknown_option');
    if (unknown.state === 'unknown_option') expect(unknown.registeredOn).toContain('research');
  });
});
