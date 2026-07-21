import { describe, expect, it } from 'vitest';

import { readGlobalFlags } from '../src/global-flags.js';

describe('@no-llm cli/global-flags', () => {
  it('parses --json, --debug, --no-llm, --no-color from argv', () => {
    const flags = readGlobalFlags({
      argv: ['ask', 'q', '--json', '--debug', '--no-llm', '--no-color'],
      env: {},
      isTty: true,
    });
    expect(flags.json).toBe(true);
    expect(flags.debug).toBe(true);
    expect(flags.noLlm).toBe(true);
    expect(flags.noColor).toBe(true);
  });

  it('treats absent flags as false', () => {
    const flags = readGlobalFlags({
      argv: ['ask', 'q'],
      env: {},
      isTty: true,
    });
    expect(flags.json).toBe(false);
    expect(flags.debug).toBe(false);
    expect(flags.noLlm).toBe(false);
    expect(flags.noColor).toBe(false);
  });

  it('honors NO_COLOR env var (https://no-color.org/)', () => {
    const flags = readGlobalFlags({
      argv: ['ask'],
      env: { NO_COLOR: '1' },
      isTty: true,
    });
    expect(flags.noColor).toBe(true);
  });

  it('forces noColor=true when stdout is not a TTY', () => {
    const flags = readGlobalFlags({
      argv: ['ask'],
      env: {},
      isTty: false,
    });
    expect(flags.noColor).toBe(true);
  });

  it('honors LLM_PROVIDER=none as noLlm=true', () => {
    const flags = readGlobalFlags({
      argv: ['ask'],
      env: { LLM_PROVIDER: 'none' },
      isTty: true,
    });
    expect(flags.noLlm).toBe(true);
  });

  it('parses --config <path> into configPath', () => {
    const flags = readGlobalFlags({
      argv: ['ask', '--config', '/tmp/yantra.yaml'],
      env: {},
      isTty: true,
    });
    expect(flags.configPath).toBe('/tmp/yantra.yaml');
  });

  it('returns configPath=null when --config is absent', () => {
    const flags = readGlobalFlags({ argv: ['ask'], env: {}, isTty: true });
    expect(flags.configPath).toBeNull();
  });
});
