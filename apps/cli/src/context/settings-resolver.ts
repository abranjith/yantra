import { loadConfig, type EffectivePreferences } from '@yantra/core';
import { COMMAND_REGISTRY, expandOptions, type LeafEntry } from '@yantra/protocol';
import type { Command } from 'commander';

import { loadEffectivePreferences } from '../preferences.js';

export type SettingSource =
  | { readonly kind: 'flag' | 'default' | 'schedule' | 'workflow' }
  | { readonly kind: 'env'; readonly name: string }
  | { readonly kind: 'preference' | 'config'; readonly key: string };
export interface ResolvedSetting {
  readonly key: string;
  readonly value: unknown;
  readonly source: SettingSource;
}
/** One invocation's environment, memoized preferences, and effective-value ledger. */
export class SettingsResolver {
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private preferencesPromise?: Promise<EffectivePreferences>;
  private command?: Command;
  private entry?: LeafEntry;
  private readonly values = new Map<string, ResolvedSetting>();
  public constructor(
    env: Readonly<NodeJS.ProcessEnv>,
    private readonly loadPreferences = loadEffectivePreferences,
  ) {
    this.environment = Object.freeze({ ...env });
  }
  env(): Readonly<NodeJS.ProcessEnv> {
    return this.environment;
  }
  preferences(): Promise<EffectivePreferences> {
    return (this.preferencesPromise ??= this.loadPreferences());
  }
  bind(entry: LeafEntry, command: Command): void {
    this.entry = entry;
    this.command = command;
  }
  record(key: string, value: unknown, source: SettingSource): void {
    this.values.set(key, { key, value, source });
  }
  recorded(): readonly ResolvedSetting[] {
    return [...this.values.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
  async option(name: string): Promise<ResolvedSetting | undefined> {
    const spec =
      this.entry &&
      expandOptions(this.entry, COMMAND_REGISTRY.option_groups).find(
        (item) => item.attribute === name,
      );
    if (!spec || !this.command) return undefined;
    const parsed = this.command.opts<Record<string, unknown>>()[name];
    for (const step of spec.precedence ?? [
      { source: 'flag' },
      { source: 'default', value: spec.default ?? null },
    ]) {
      let value: unknown;
      let source: SettingSource;
      switch (step.source) {
        case 'flag':
          if (this.command.getOptionValueSource(name) !== 'cli') continue;
          value = parsed;
          source = { kind: 'flag' };
          break;
        case 'env':
          value = this.environment[step.name];
          if (
            value === undefined ||
            value === '' ||
            (step.equals !== undefined && value !== step.equals)
          )
            continue;
          if (step.equals !== undefined) value = true;
          source = { kind: 'env', name: step.name };
          break;
        case 'preference': {
          const preference = (await this.preferences()).get(step.key);
          if (!preference) continue;
          value = preference.value;
          source = { kind: 'preference', key: step.key };
          break;
        }
        case 'config': {
          const loaded = await loadConfig();
          if (!loaded.isOk) continue;
          value = step.key
            .split('.')
            .reduce<unknown>(
              (v, k) =>
                v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined,
              loaded.value,
            );
          if (value === undefined) continue;
          source = { kind: 'config', key: step.key };
          break;
        }
        case 'default':
          value = step.value;
          source = { kind: 'default' };
          break;
      }
      const setting = { key: name, value, source };
      this.record(name, value, source);
      return setting;
    }
    return undefined;
  }
}
