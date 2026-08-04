import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProfile, profilePath } from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectContextGrants,
  defaultContextGrantAnswers,
  type ContextGrantAnswers,
} from '../../src/commands/init-context-prompts.js';
import { makeInitCommand } from '../../src/commands/init.js';

describe('@no-llm collectContextGrants', () => {
  it('maps a yes onto the grant and records the city', async () => {
    const answers = await collectContextGrants({
      confirm: async () => true,
      text: async () => 'Naperville, IL',
    });
    expect(answers).toEqual({ grants: { location: true }, city: 'Naperville, IL' });
  });

  it('maps a no onto the grant and skips the city question entirely', async () => {
    const text = vi.fn(async () => 'Naperville, IL');
    const answers = await collectContextGrants({ confirm: async () => false, text });
    expect(answers).toEqual({ grants: { location: false }, city: null });
    expect(text).not.toHaveBeenCalled();
  });

  it('treats a blank city as granted-but-unset', async () => {
    const answers = await collectContextGrants({
      confirm: async () => true,
      text: async () => '   ',
    });
    expect(answers).toEqual({ grants: { location: true }, city: null });
  });

  it('trims a city answer', async () => {
    const answers = await collectContextGrants({
      confirm: async () => true,
      text: async () => '  Naperville, IL  ',
    });
    expect(answers.city).toBe('Naperville, IL');
  });

  it('falls back to defaults when the grant prompt is cancelled', async () => {
    const answers = await collectContextGrants({ confirm: async () => null });
    expect(answers).toEqual(defaultContextGrantAnswers());
  });

  it('treats a cancelled city prompt as blank rather than throwing', async () => {
    const answers = await collectContextGrants({
      confirm: async () => true,
      text: async () => null,
    });
    expect(answers).toEqual({ grants: { location: true }, city: null });
  });

  it('asks exactly one question when the grant is declined', async () => {
    const confirm = vi.fn(async () => false);
    await collectContextGrants({ confirm, text: async () => '' });
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe('@no-llm yantra init context questionnaire', () => {
  let dir: string;
  let savedEnv: Record<string, string | undefined>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitCodes: number[];

  /**
   * Thrown in place of a real `process.exit` so the action unwinds. init's own
   * `catch` swallows it and exits again, so the *first* recorded code — not the
   * escaping one — is the command's real outcome.
   */
  class ExitSignal extends Error {
    public constructor(public readonly code: number) {
      super(`exit ${code}`);
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yantra-init-'));
    savedEnv = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, APPDATA: process.env.APPDATA };
    // Cover both platform branches of `configDir()` so the suite is portable.
    process.env.XDG_CONFIG_HOME = dir;
    process.env.APPDATA = dir;
    exitCodes = [];
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0);
      throw new ExitSignal(code ?? 0);
    }) as never);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  /** Runs `yantra init`, returning the exit code the command actually reached. */
  async function runInit(
    argv: readonly string[],
    deps: Parameters<typeof makeInitCommand>[0] = {},
  ): Promise<number> {
    exitCodes = [];
    try {
      await makeInitCommand(deps).parseAsync([...argv], { from: 'user' });
    } catch (error) {
      if (!(error instanceof ExitSignal)) throw error;
    }
    return exitCodes[0] ?? 0;
  }

  function collector(answers: ContextGrantAnswers): () => Promise<ContextGrantAnswers> {
    return async () => answers;
  }

  it('calls the collector exactly once on a TTY without --json or --yes', async () => {
    const collect = vi.fn(collector({ grants: { location: true }, city: 'Naperville, IL' }));
    const code = await runInit([], { isTty: true, collect });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
  });

  it('does not prompt with --json', async () => {
    const collect = vi.fn(collector({ grants: { location: false }, city: null }));
    await runInit(['--json'], { isTty: true, collect });
    expect(collect).not.toHaveBeenCalled();
  });

  it('does not prompt with --yes on a TTY', async () => {
    const collect = vi.fn(collector({ grants: { location: false }, city: null }));
    await runInit(['--yes'], { isTty: true, collect });
    expect(collect).not.toHaveBeenCalled();
  });

  it('does not prompt on a non-TTY (CI is unaffected)', async () => {
    const collect = vi.fn(collector({ grants: { location: false }, city: null }));
    await runInit([], { isTty: false, collect });
    expect(collect).not.toHaveBeenCalled();
  });

  it('writes the behaviour-preserving defaults when it does not prompt', async () => {
    await runInit(['--json'], { isTty: true });
    const profile = await loadProfile(profilePath());
    expect(profile.isOk).toBe(true);
    if (profile.isOk) {
      expect(profile.value.context.location).toBe(true);
      expect(profile.value.locale.city).toBeNull();
    }
  });

  it('round-trips the answers into the written YAML and back through loadProfile', async () => {
    await runInit([], {
      isTty: true,
      collect: collector({ grants: { location: true }, city: 'Naperville, IL' }),
    });

    const contents = await readFile(profilePath(), 'utf8');
    expect(contents).toContain('city: Naperville, IL');
    expect(contents).toContain('location: true');

    const profile = await loadProfile(profilePath());
    expect(profile.isOk).toBe(true);
    if (profile.isOk) {
      expect(profile.value.locale.city).toBe('Naperville, IL');
      expect(profile.value.context.location).toBe(true);
    }
  });

  it('persists a declined grant', async () => {
    await runInit([], {
      isTty: true,
      collect: collector({ grants: { location: false }, city: null }),
    });
    const profile = await loadProfile(profilePath());
    expect(profile.isOk).toBe(true);
    if (profile.isOk) {
      expect(profile.value.context.location).toBe(false);
      expect(profile.value.locale.city).toBeNull();
    }
  });

  it('does not prompt on a re-run over an existing profile without --reset', async () => {
    await runInit([], {
      isTty: true,
      collect: collector({ grants: { location: false }, city: null }),
    });

    // Second run: config.yaml exists, so init short-circuits before the profile.
    const collect = vi.fn(collector({ grants: { location: true }, city: 'Elsewhere' }));
    expect(await runInit([], { isTty: true, collect })).toBe(0);
    expect(collect).not.toHaveBeenCalled();

    const profile = await loadProfile(profilePath());
    if (!profile.isOk) throw new Error('expected a profile');
    expect(profile.value.context.location).toBe(false);
  });

  it('prompts again on --reset and overwrites the previous answers', async () => {
    await runInit([], {
      isTty: true,
      collect: collector({ grants: { location: false }, city: null }),
    });
    const collect = vi.fn(collector({ grants: { location: true }, city: 'Naperville, IL' }));
    await runInit(['--reset'], { isTty: true, collect });
    expect(collect).toHaveBeenCalledTimes(1);

    const profile = await loadProfile(profilePath());
    if (!profile.isOk) throw new Error('expected a profile');
    expect(profile.value.context.location).toBe(true);
    expect(profile.value.locale.city).toBe('Naperville, IL');
  });

  it('emits no prompt output on the --json path', async () => {
    await runInit(['--json'], { isTty: true });
    const written = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(written).not.toContain('Location sharing');
    expect(written).toContain('"kind":"init"');
  });

  it('names the profile file and how to change the grant on the human path', async () => {
    await runInit([], {
      isTty: true,
      collect: collector({ grants: { location: false }, city: null }),
    });
    const written = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('profile.yaml');
    expect(written).toContain('yantra prefs set context.location true');
  });
});
