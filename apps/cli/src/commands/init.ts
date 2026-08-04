/**
 * `yantra init` — bootstraps the user's first config file.
 *
 * It writes a default `~/.config/yantra/config.yaml` (path resolved via
 * {@link configPath}) with the chosen LLM provider, and seeds the
 * human-editable `profile.yaml`.
 *
 * **Interactivity is opt-out, and scripted use is unaffected.** The only
 * interactive step is the sensitive-context questionnaire
 * ({@link collectContextGrants}), which asks what the agent may be told about
 * the user. It fires only on an interactive TTY, without `--json` or `--yes`,
 * and only when the profile is actually being written (absent, or `--reset`).
 * Every other path — CI, pipes, `--json`, re-runs over an existing profile —
 * writes the behavior-preserving defaults silently. Remaining provisioning
 * (Chrome selection, profile-mode warning, API-key seeding) is still deferred;
 * the user can edit the YAML directly or use `yantra config set`.
 *
 * @example
 *   yantra init --provider none      # `--no-llm`-only mode, no API keys
 *   yantra init --provider anthropic # writes the YAML; key seeded via env
 *   yantra init --reset              # back up + rewrite the YAML
 *   yantra init --yes                # accept defaults without prompting
 */

import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { configPath, defaultProfile, profilePath, saveProfile } from '@yantra/core';
import { Command } from 'commander';

import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';

import {
  collectContextGrants,
  defaultContextGrantAnswers,
  type ContextGrantAnswers,
  type ContextGrantDeps,
} from './init-context-prompts.js';

interface InitOptions {
  readonly provider?: string;
  readonly reset?: boolean;
  readonly json?: boolean;
  readonly yes?: boolean;
}

/** Injectable boundaries so the interactive path is testable without a terminal. */
export interface InitDeps {
  /** Whether stdin is an interactive terminal; defaults to the real check. */
  readonly isTty?: boolean;
  /** The questionnaire; defaults to {@link collectContextGrants}. */
  readonly collect?: (deps?: ContextGrantDeps) => Promise<ContextGrantAnswers>;
}

const ALLOWED_PROVIDERS = new Set(['anthropic', 'ollama', 'none']);

export function makeInitCommand(deps: InitDeps = {}): Command {
  const cmd = new Command('init');

  cmd
    .description('Create or update ~/.config/yantra/config.yaml')
    .option('--provider <name>', "default LLM provider: 'anthropic' | 'ollama' | 'none'", 'none')
    .option('--reset', 'back up the existing config (if any) and rewrite from defaults', false)
    .option('--json', 'emit a JSON status object after writing', false)
    .option('--yes', 'accept defaults without prompting; implied for non-TTY and --json', false)
    .action(async (options: InitOptions) => {
      try {
        const target = configPath();
        const provider = (options.provider ?? 'none').toLowerCase();
        if (!ALLOWED_PROVIDERS.has(provider)) {
          process.stderr.write(
            `Unknown provider "${provider}" (expected: anthropic | ollama | none)\n`,
          );
          process.exit(1);
        }

        await mkdir(dirname(target), { recursive: true });

        const alreadyExists = await fileExists(target);
        if (alreadyExists && options.reset !== true) {
          if (options.json === true) {
            process.stdout.write(
              `${JSON.stringify({
                schemaVersion: CLI_JSON_SCHEMA_VERSION,
                kind: 'init',
                status: 'already-initialized',
                configPath: target,
              })}\n`,
            );
          } else {
            process.stdout.write(`Already initialized at ${target}. Pass --reset to rewrite.\n`);
          }
          process.exit(0);
        }

        if (alreadyExists) {
          await rename(target, `${target}.bak.${Date.now()}`);
        }

        const content = buildConfig(provider);
        await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });

        // Seed the human-editable personalization profile, recording the user's
        // sensitive-context consent answers alongside the defaults. Only written
        // when absent (or on --reset) so hand edits are never clobbered — which
        // is also why the questionnaire is gated on the same condition: never
        // ask a question whose answer would be discarded.
        const profileTarget = profilePath();
        const writingProfile = options.reset === true || !(await fileExists(profileTarget));
        let answers = defaultContextGrantAnswers();
        if (writingProfile) {
          if (shouldPrompt(options, deps)) {
            answers = await (deps.collect ?? collectContextGrants)();
          }
          const profile = defaultProfile();
          await saveProfile(
            {
              ...profile,
              locale: { ...profile.locale, city: answers.city },
              context: { ...profile.context, location: answers.grants.location },
            },
            profileTarget,
          );
        }

        if (options.json === true) {
          process.stdout.write(
            `${JSON.stringify({
              schemaVersion: CLI_JSON_SCHEMA_VERSION,
              kind: 'init',
              status: 'written',
              configPath: target,
              provider,
            })}\n`,
          );
        } else {
          process.stdout.write(`Wrote ${target}\n`);
          process.stdout.write(`Default LLM provider: ${provider}\n`);
          if (writingProfile) {
            process.stdout.write(`Wrote ${profileTarget}\n`);
            process.stdout.write(
              answers.grants.location
                ? 'Location sharing: on. Change it with `yantra prefs set context.location false`.\n'
                : 'Location sharing: off. Change it with `yantra prefs set context.location true`.\n',
            );
          }
          if (provider === 'anthropic') {
            process.stdout.write(
              'Next: set ANTHROPIC_API_KEY in your environment or seed it in the keychain.\n',
            );
          }
        }
        process.exit(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`init failed: ${message}\n`);
        process.exit(1);
      }
    });

  return cmd;
}

function buildConfig(provider: string): string {
  return [
    '# yantra config — managed by `yantra init` / `yantra config`',
    `# generated: ${new Date().toISOString()}`,
    '',
    'provider:',
    `  default: ${provider}`,
    '  anthropic:',
    '    model: claude-opus-4-7',
    '  ollama:',
    '    baseUrl: http://localhost:11434',
    '    model: llama3.1:8b',
    '',
    'search:',
    "  provider: auto # 'auto' | 'google' | 'duckduckgo' | 'brave' | 'tavily'",
    '  # order `auto` walks, skipping providers whose API key is missing.',
    '  # google is opt-in (highest anti-bot friction) — add it explicitly if wanted.',
    '  fallback_chain:',
    '    - tavily',
    '    - brave',
    '    - duckduckgo',
    '  # API keys live in the OS keychain (tavily.api_key / brave.api_key), never here.',
    '',
    'ethics:',
    '  robots_enabled: false # opt-in robots.txt enforcement',
    '',
    'retention:',
    '  runsDays: 30',
    '',
  ].join('\n');
}

/**
 * Whether the grant questionnaire may run. All three conditions must hold:
 * an interactive terminal to ask in, no `--json` (machine-readable output has
 * no room for questions), and no `--yes`. Non-TTY implies `--yes`, which is
 * what keeps CI and scripted use unaffected.
 */
function shouldPrompt(options: InitOptions, deps: InitDeps): boolean {
  const isTty = deps.isTty ?? process.stdin.isTTY === true;
  return isTty && options.json !== true && options.yes !== true;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
