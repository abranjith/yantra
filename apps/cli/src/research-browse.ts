/**
 * Whether one agentic `research` run gets the read-only browser
 * (navigate, observe, extract — never click or fill).
 *
 * The mode lives in the stored preference `agent.research_browse` (default
 * `true`); `--no-browse` overrides it downward for a single run. There is no
 * environment layer: a run's catalog is decided by the user's saved choice
 * and the flag they typed, nothing else (memory §General).
 */

import { preferenceValue, type EffectivePreferences } from '@yantra/core';
import { Option, type Command } from 'commander';

/** Parsed value registered by {@link addNoBrowseOption}. */
export interface NoBrowseOption {
  /**
   * Commander stores `--no-browse` as `browse: false`. A lone negatable option
   * also defaults to `true` when absent, so only `false` is ever a user choice.
   */
  readonly browse?: boolean;
}

/** The browse decision for one run and which layer made it. */
export interface ResearchBrowseResolution {
  readonly enabled: boolean;
  readonly source: 'flag' | 'preference' | 'default';
}

/**
 * Registers `--no-browse`. `research` only: `ask` never browses and `do`
 * always does, so the flag would be a dead control on either.
 */
export function addNoBrowseOption(command: Command): Command {
  return command.addOption(
    new Option('--no-browse', 'run research without the read-only browser for this run'),
  );
}

/**
 * Resolves `--no-browse` > `agent.research_browse` > pinned `true`.
 *
 * A stored value is schema-validated at write time, so a non-boolean cannot
 * normally occur; one that does is treated as unset rather than guessed at.
 */
export function resolveResearchBrowse(
  options: NoBrowseOption,
  prefs: EffectivePreferences,
): ResearchBrowseResolution {
  if (options.browse === false) return { enabled: false, source: 'flag' };
  const stored = preferenceValue<unknown>(prefs, 'agent.research_browse', null);
  if (typeof stored === 'boolean') return { enabled: stored, source: 'preference' };
  return { enabled: true, source: 'default' };
}
