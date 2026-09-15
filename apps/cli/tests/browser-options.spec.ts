/**
 * The shared browser-selection option group.
 *
 * Two halves are asserted, because memory records that only asserting one lets
 * the surface rot: the flags are spelled *identically* everywhere they are
 * registered, and every command that cannot honor them rejects them as unknown
 * options. A flag a command cannot act on is a dead control, not shared
 * vocabulary.
 */

import { Command, CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import {
  addBrowserSelectionOptions,
  resolveBrowserSelectionOverride,
} from '../src/browser-options.js';
import { registerAskCommand } from '../src/commands/ask.js';
import { makeBrowserCommand } from '../src/commands/browser.js';
import { makeConfigCommand } from '../src/commands/config.js';
import { makeDaemonCommand } from '../src/commands/daemon.js';
import { registerDoCommand } from '../src/commands/do.js';
import { makeDoctorCommand } from '../src/commands/doctor.js';
import { makeInitCommand } from '../src/commands/init.js';
import { makeListCommand } from '../src/commands/list.js';
import { registerResearchCommand } from '../src/commands/research.js';
import { makeResumeCommand } from '../src/commands/resume.js';
import { makeRunCommand } from '../src/commands/run.js';
import { makeScheduleCommand } from '../src/commands/schedule.js';

const CHROME = '/opt/google/chrome/chrome';

/** Long flags a command and its subcommands register, flattened. */
function longFlags(command: Command): readonly string[] {
  return [
    ...command.options.map((option) => option.long),
    ...command.commands.flatMap((sub) => sub.options.map((option) => option.long)),
  ].filter((flag): flag is string => typeof flag === 'string');
}

describe('@no-llm browser selection option group', () => {
  describe('normalization', () => {
    it('returns no override when neither flag was supplied', () => {
      expect(resolveBrowserSelectionOverride({})).toBeUndefined();
    });

    it.each(['auto', 'managed'] as const)('maps --browser %s to a pathless selection', (source) => {
      expect(resolveBrowserSelectionOverride({ browser: source })).toEqual({
        source,
        executablePath: null,
      });
    });

    // The override is a *whole* selection, so `system` with no path clears a
    // configured custom path for this invocation rather than inheriting it.
    it('maps --browser system alone to discovery with a null path', () => {
      expect(resolveBrowserSelectionOverride({ browser: 'system' })).toEqual({
        source: 'system',
        executablePath: null,
      });
    });

    it('lets --browser-path alone imply system', () => {
      expect(resolveBrowserSelectionOverride({ browserPath: CHROME })).toEqual({
        source: 'system',
        executablePath: CHROME,
      });
    });

    it('accepts --browser system with an explicit path', () => {
      expect(resolveBrowserSelectionOverride({ browser: 'system', browserPath: CHROME })).toEqual({
        source: 'system',
        executablePath: CHROME,
      });
    });

    it.each(['auto', 'managed'] as const)(
      'rejects --browser %s combined with --browser-path',
      (source) => {
        expect(() =>
          resolveBrowserSelectionOverride({ browser: source, browserPath: CHROME }),
        ).toThrow(CommanderError);
      },
    );

    it('rejects a relative --browser-path with the same grammar as the config schema', () => {
      expect(() => resolveBrowserSelectionOverride({ browserPath: 'chrome/chrome' })).toThrow(
        /absolute/u,
      );
    });

    it('rejects an empty --browser-path', () => {
      expect(() => resolveBrowserSelectionOverride({ browserPath: '   ' })).toThrow(
        /must not be empty/u,
      );
    });

    it('rejects an unknown source and names the accepted ones', () => {
      expect(() => resolveBrowserSelectionOverride({ browser: 'firefox' })).toThrow(
        /auto, managed, system/u,
      );
    });

    it('reports a conflict differently from an invalid path', () => {
      const conflict = captureMessage(() =>
        resolveBrowserSelectionOverride({ browser: 'managed', browserPath: CHROME }),
      );
      const invalid = captureMessage(() =>
        resolveBrowserSelectionOverride({ browserPath: 'relative' }),
      );
      expect(conflict).not.toBe(invalid);
    });

    it('exits 1 for every validation failure', () => {
      for (const options of [
        { browser: 'firefox' },
        { browser: 'auto', browserPath: CHROME },
        { browserPath: 'relative' },
      ]) {
        try {
          resolveBrowserSelectionOverride(options);
          expect.unreachable('expected a validation failure');
        } catch (error) {
          expect((error as CommanderError).exitCode).toBe(1);
        }
      }
    });
  });

  describe('registration', () => {
    /** Every command that can actually launch a browser. */
    const REGISTERED: readonly (readonly [string, () => Command, string | undefined])[] = [
      ['run', makeRunCommand, undefined],
      ['resume', makeResumeCommand, undefined],
      ['ask', () => registeredOn('ask'), undefined],
      ['research', () => registeredOn('research'), undefined],
      ['do', () => registeredOn('do'), undefined],
      ['browser check', makeBrowserCommand, 'check'],
    ];

    it.each(REGISTERED)('%s registers both flags', (_label, build, subcommand) => {
      const command = build();
      const target =
        subcommand === undefined
          ? command
          : command.commands.find((sub) => sub.name() === subcommand);
      expect(target).toBeDefined();
      const flags = (target as Command).options.map((option) => option.long);
      expect(flags).toContain('--browser');
      expect(flags).toContain('--browser-path');
    });

    // Identical spelling is the half that keeps the surface readable. The
    // comparison is over the declared flags and descriptions, not the rendered
    // help: Commander's column padding and line wrapping are layout, and
    // comparing those reports a difference where there is none.
    it('spells the flags identically on every command that registers them', () => {
      const declared = REGISTERED.map(([, build, subcommand]) => {
        const command = build();
        const target =
          subcommand === undefined
            ? command
            : (command.commands.find((sub) => sub.name() === subcommand) ?? command);
        return target.options
          .filter((option) => option.long?.startsWith('--browser') === true)
          .map((option) => `${option.flags} :: ${String(option.description)}`)
          .sort()
          .join('\n');
      });

      expect(new Set(declared).size).toBe(1);
      expect(declared[0]).toContain('--browser <source>');
      expect(declared[0]).toContain('--browser-path <path>');
    });

    /** Unattended and non-launching surfaces. */
    const UNREGISTERED: readonly (readonly [string, () => Command])[] = [
      ['daemon', makeDaemonCommand],
      ['schedule', makeScheduleCommand],
      ['init', makeInitCommand],
      ['list', makeListCommand],
      ['config', makeConfigCommand],
      ['doctor', makeDoctorCommand],
    ];

    it.each(UNREGISTERED)('%s registers neither flag', (_label, build) => {
      const flags = longFlags(build());
      expect(flags).not.toContain('--browser');
      expect(flags).not.toContain('--browser-path');
    });

    it.each(['list', 'use', 'install'])(
      'browser %s registers neither flag — it launches nothing',
      (name) => {
        const sub = makeBrowserCommand().commands.find((candidate) => candidate.name() === name);
        expect(sub).toBeDefined();
        const flags = (sub as Command).options.map((option) => option.long);
        expect(flags).not.toContain('--browser');
        expect(flags).not.toContain('--browser-path');
      },
    );

    it('rejects --browser on a command that cannot honor it', async () => {
      const daemon = makeDaemonCommand().exitOverride();
      daemon.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
      for (const sub of daemon.commands) {
        sub.exitOverride();
        sub.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
      }
      await expect(
        daemon.parseAsync(['start', '--browser', 'managed'], { from: 'user' }),
      ).rejects.toMatchObject({ code: 'commander.unknownOption' });
    });

    it('registers the group without attaching a Commander default', () => {
      // An absent flag has to stay absent: a default would make "the user asked
      // for auto" indistinguishable from "the user said nothing", and only the
      // second falls through to the configured selection.
      const command = addBrowserSelectionOptions(new Command('probe'));
      command.action(() => undefined);
      command.parse([], { from: 'user' });
      const values = command.opts<Record<string, unknown>>();
      expect(values.browser).toBeUndefined();
      expect(values.browserPath).toBeUndefined();
    });
  });
});

describe('@no-llm browser command surface guarantees', () => {
  /** Long flags a command registers, by subcommand name. */
  function subcommand(name: string): Command {
    const found = makeBrowserCommand().commands.find((sub) => sub.name() === name);
    if (found === undefined) throw new Error(`browser ${name} is not registered`);
    return found;
  }

  /**
   * Help text as prose: Commander wraps descriptions at the terminal width, so a
   * phrase can be split across lines by layout alone.
   */
  function helpProse(name: string): string {
    return subcommand(name).helpInformation().toLowerCase().replace(/\s+/gu, ' ');
  }

  // FEAT-046 adds `browser update --dry-run`, an availability query that does
  // contact the network. `check` is its opposite, and a reader has to be able to
  // tell them apart from the help text alone — one word meaning two opposite
  // things inside one noun namespace is the failure this guards.
  it('describes `browser check` as local, so it cannot be read as an availability query', () => {
    const help = helpProse('check');

    expect(help).toContain('local');
    expect(help).toContain('no network');
    // Where the help does mention a newer browser it says it does *not* look for
    // one — the opposite claim from an availability query — and it offers no
    // `--dry-run`, which is FEAT-046's spelling for that question.
    expect(help).toContain('does not look for a newer browser');
    expect(help).not.toContain('--dry-run');
  });

  it('describes `browser list` as local with no network, install, or update check', () => {
    const help = helpProse('list');
    expect(help).toContain('no network');
    expect(help).toContain('update check');
  });

  it('describes `browser use` as not launching a browser', () => {
    const help = helpProse('use');
    expect(help).toContain('never launches');
  });

  it('accepts --browser-path only where a browser can launch', () => {
    // `use` takes `--path` under an explicit `system` argument instead, so the
    // invocation-override spelling must not appear there.
    const useFlags = subcommand('use').options.map((option) => option.long);
    expect(useFlags).toContain('--path');
    expect(useFlags).not.toContain('--browser-path');
  });
});

function captureMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

/**
 * Builds a program with the agentic commands registered and returns one of them.
 *
 * `ask`, `research`, and `do` register themselves onto a program rather than
 * returning a Command, so the group is inspected where it actually lands.
 */
function registeredOn(name: string): Command {
  const program = new Command();
  registerAskCommand(program);
  registerResearchCommand(program);
  registerDoCommand(program);
  const found = program.commands.find((sub) => sub.name() === name);
  if (found === undefined) throw new Error(`command "${name}" was not registered`);
  return found;
}
