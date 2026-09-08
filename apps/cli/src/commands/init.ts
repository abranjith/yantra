import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, win32 } from 'node:path';

import {
  configPath,
  defaultConfig,
  defaultProfile,
  profilePath,
  redactConfigRefs,
  saveProfile,
  type YantraConfig,
} from '@yantra/core';
import { Command } from 'commander';
import { stringify } from 'yaml';

import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';

import {
  collectContextGrants,
  defaultContextGrantAnswers,
  type ContextGrantAnswers,
  type ContextGrantDeps,
} from './init-context-prompts.js';
import { runInitWizard, type InitWizardAnswers, type InitWizardDeps } from './init-wizard.js';

interface InitOptions {
  readonly provider?: string;
  readonly reset?: boolean;
  readonly json?: boolean;
  readonly yes?: boolean;
}

export interface InitDeps {
  readonly isTty?: boolean;
  readonly collect?: (deps?: ContextGrantDeps) => Promise<ContextGrantAnswers>;
  readonly wizard?: (deps?: InitWizardDeps) => Promise<InitWizardAnswers>;
}

const ALLOWED_PROVIDERS = new Set(['anthropic', 'ollama', 'none']);

export function makeInitCommand(deps: InitDeps = {}): Command {
  return new Command('init')
    .description('Create or update ~/.yantra/config.yaml')
    .option('--provider <name>', "default model provider: 'anthropic' | 'ollama' | 'none'")
    .option('--reset', 'back up existing files and rewrite from defaults', false)
    .option('--json', 'emit a JSON status object after writing', false)
    .option('--yes', 'accept defaults without prompting', false)
    .action(async (options: InitOptions) => {
      try {
        const target = configPath();
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const alreadyExists = await fileExists(target);
        if (alreadyExists && options.reset !== true) {
          if (options.json)
            process.stdout.write(
              `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: 'init', status: 'already-initialized', configPath: target })}\n`,
            );
          else process.stdout.write(`Already initialized at ${target}. Pass --reset to rewrite.\n`);
          process.exit(0);
        }
        if (alreadyExists) await rename(target, `${target}.bak.${Date.now()}`);

        const interactive = shouldPrompt(options, deps);
        const requestedProvider = (options.provider ?? 'none').toLowerCase();
        if (!ALLOWED_PROVIDERS.has(requestedProvider)) {
          process.stderr.write(
            `Unknown provider "${requestedProvider}" (expected: anthropic | ollama | none)\n`,
          );
          process.exit(1);
        }
        const answers =
          interactive && options.provider === undefined
            ? await (deps.wizard ?? runInitWizard)()
            : defaultsFor(requestedProvider as InitWizardAnswers['provider']);
        if (answers.dataDir && !(isAbsolute(answers.dataDir) || win32.isAbsolute(answers.dataDir)))
          throw new Error('the data directory must be absolute');
        if (answers.dataDir) await mkdir(answers.dataDir, { recursive: true, mode: 0o700 });

        const config = buildConfig(answers);
        await writeFile(target, stringify(serializable(config)), { encoding: 'utf8', mode: 0o600 });

        const profileTarget = profilePath();
        const writingProfile = options.reset === true || !(await fileExists(profileTarget));
        let grants = defaultContextGrantAnswers();
        if (writingProfile) {
          if (interactive) grants = await (deps.collect ?? collectContextGrants)();
          const profile = defaultProfile();
          await saveProfile(
            {
              ...profile,
              locale: { ...profile.locale, city: grants.city },
              context: { ...profile.context, location: grants.grants.location },
              agent: {
                ...profile.agent,
                provider: answers.provider === 'none' ? null : answers.provider,
                model: answers.modelId,
              },
            },
            profileTarget,
          );
        }

        if (options.json)
          process.stdout.write(
            `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: 'init', status: 'written', configPath: target, provider: answers.provider })}\n`,
          );
        else {
          process.stdout.write(`Wrote ${target}\n`);
          if (writingProfile) {
            process.stdout.write(`Wrote ${profileTarget}\n`);
            process.stdout.write(
              grants.grants.location
                ? 'Location sharing: on. Change it with `yantra prefs set context.location false`.\n'
                : 'Location sharing: off. Change it with `yantra prefs set context.location true`.\n',
            );
          }
          process.stdout.write('Next: yantra model list; yantra secret list; yantra config path\n');
        }
        process.exit(0);
      } catch (error) {
        process.stderr.write(
          `init failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      }
    });
}

function defaultsFor(provider: InitWizardAnswers['provider']): InitWizardAnswers {
  if (provider === 'anthropic')
    return {
      provider,
      modelId: 'claude-opus-4-7',
      baseUrl: null,
      apiKey: { kind: 'env', name: 'ANTHROPIC_API_KEY' },
      dataDir: null,
    };
  if (provider === 'ollama')
    return {
      provider,
      modelId: 'llama3.1:8b',
      baseUrl: 'http://localhost:11434',
      apiKey: null,
      dataDir: null,
    };
  return { provider: 'none', modelId: null, baseUrl: null, apiKey: null, dataDir: null };
}

function buildConfig(answers: InitWizardAnswers): YantraConfig {
  const base = defaultConfig();
  return {
    ...base,
    paths: { ...base.paths, data_dir: answers.dataDir },
    models:
      answers.provider === 'none' || !answers.modelId
        ? []
        : [
            {
              id: answers.modelId,
              provider: answers.provider,
              base_url: answers.baseUrl,
              api_key: answers.apiKey,
              input: ['text'],
            },
          ],
  };
}

function serializable(config: YantraConfig): unknown {
  const raw = redactConfigRefs(config) as Record<string, unknown>;
  const models = (raw.models as Record<string, unknown>[]).map((model) =>
    Object.fromEntries(
      Object.entries(model).filter(
        ([key, value]) => !((key === 'api_key' || key === 'base_url') && value === null),
      ),
    ),
  );
  return { ...raw, models };
}

function shouldPrompt(options: InitOptions, deps: InitDeps): boolean {
  return (
    (deps.isTty ?? process.stdin.isTTY === true) && options.json !== true && options.yes !== true
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
