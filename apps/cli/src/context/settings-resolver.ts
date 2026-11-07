import { readFile } from 'node:fs/promises';

import {
  loadConfig,
  profilePath,
  type EffectivePreferences,
  type ExecutionReceiptDraft,
} from '@yantra/core';
import {
  COMMAND_REGISTRY,
  PROTOCOL_VERSION,
  JsonValue,
  expandOptions,
  type LeafEntry,
  type ContentIdentity,
  type ReceiptBrowserSelection,
  type ReceiptSetting,
  type SettingSource,
} from '@yantra/protocol';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';

import { loadEffectivePreferences } from '../preferences.js';
import { KNOWN_DEAD_OPTIONS } from '../registry/dead-options.js';

export type { SettingSource } from '@yantra/protocol';
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
  private profileDocument?: Promise<unknown>;
  public constructor(
    env: Readonly<NodeJS.ProcessEnv>,
    private readonly loadPreferences = loadEffectivePreferences,
    private readonly metadata?: {
      readonly cwd: string;
      readonly surface: 'terminal' | 'worker' | 'daemon';
      readonly invocationId: string | null;
    },
  ) {
    this.environment = Object.freeze({ ...env });
  }
  env(): Readonly<NodeJS.ProcessEnv> {
    return this.environment;
  }
  preferences(): Promise<EffectivePreferences> {
    return (this.preferencesPromise ??= this.loadPreferences());
  }
  usePreferences(value: EffectivePreferences): void {
    this.preferencesPromise = Promise.resolve(value);
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
  /** Record the value used by a composite resolver, keeping the registry source chain. */
  async effective(key: string, value: unknown): Promise<void> {
    const option = await this.option(key);
    this.record(key, value, option?.source ?? { kind: 'default' });
  }
  async draftReceipt(
    command: readonly string[],
    options: {
      readonly content?: readonly ContentIdentity[];
      readonly browser?: ReceiptBrowserSelection | null;
    } = {},
  ): Promise<ExecutionReceiptDraft> {
    if (!this.metadata || !this.entry || !command[0])
      throw new Error('Receipt resolver must be bound to an invocation');
    const specs = expandOptions(this.entry, COMMAND_REGISTRY.option_groups);
    const allowedEnv = new Set(
      specs.flatMap(
        (s) => s.precedence?.flatMap((p) => (p.source === 'env' ? [p.name] : [])) ?? [],
      ),
    );
    const excluded = new Set(
      specs
        .filter(
          (s) =>
            s.input.kind === 'secret-input' ||
            KNOWN_DEAD_OPTIONS.some((d) => d.command === this.entry!.id && d.option === s.long),
        )
        .map((s) => s.attribute),
    );
    for (const spec of specs) {
      if (!excluded.has(spec.attribute) && !this.values.has(spec.attribute)) {
        const resolved = await this.option(spec.attribute);
        if (!resolved)
          this.record(
            spec.attribute,
            this.command?.opts<Record<string, unknown>>()[spec.attribute] ?? null,
            { kind: 'default' },
          );
      }
    }
    const settings: ReceiptSetting[] = this.recorded()
      .filter(
        (s) => !excluded.has(s.key) && (s.source.kind !== 'env' || allowedEnv.has(s.source.name)),
      )
      .map((s) => ({ key: s.key, value: JsonValue.parse(s.value ?? null), source: s.source }));
    return {
      schema_version: 1,
      yantra_version: `${PROTOCOL_VERSION} (yantra cli)`,
      invoked_by: this.metadata.surface,
      invocation_id: this.metadata.invocationId,
      command: [command[0], ...command.slice(1)],
      cwd: this.metadata.cwd,
      settings,
      content: [...(options.content ?? [])],
      browser: options.browser ?? null,
    };
  }
  private async authoredPreference(key: string): Promise<boolean> {
    this.profileDocument ??= readFile(profilePath(), 'utf8')
      .then((text) => parseYaml(text) as unknown)
      .catch(() => null);
    return (
      key
        .split('.')
        .reduce<unknown>(
          (v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined),
          await this.profileDocument,
        ) !== undefined
    );
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
      { source: 'default', value: parsed ?? spec.default ?? null },
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
          if (step.equals !== undefined) value = spec.negatable ? false : true;
          source = { kind: 'env', name: step.name };
          break;
        case 'preference': {
          const preference = (await this.preferences()).get(step.key);
          if (!preference) continue;
          value = preference.value;
          source =
            preference.provenance === 'profile.yaml' && !(await this.authoredPreference(step.key))
              ? { kind: 'default' }
              : { kind: 'preference', key: step.key };
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
