/**
 * `yantra init` — bootstraps the user's first config file.
 *
 * MVP is a minimal non-interactive init suitable for CI and scripted use.
 * It writes a default `~/.config/yantra/config.yaml` (path resolved via
 * {@link configPath}) with the chosen LLM provider. Subsequent interactive
 * provisioning (Chrome selection, profile-mode warning, API-key seeding)
 * is intentionally deferred — the user can edit the YAML directly or use
 * `yantra config set` (TASK-001b) when those land.
 *
 * @example
 *   yantra init --provider none      # `--no-llm`-only mode, no API keys
 *   yantra init --provider anthropic # writes the YAML; key seeded via env
 *   yantra init --reset              # back up + rewrite the YAML
 */

import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { configPath } from '@yantra/core';
import { Command } from 'commander';

interface InitOptions {
  readonly provider?: string;
  readonly reset?: boolean;
  readonly json?: boolean;
}

const ALLOWED_PROVIDERS = new Set(['anthropic', 'ollama', 'none']);

export function makeInitCommand(): Command {
  const cmd = new Command('init');

  cmd
    .description('Create or update ~/.config/yantra/config.yaml')
    .option('--provider <name>', "default LLM provider: 'anthropic' | 'ollama' | 'none'", 'none')
    .option('--reset', 'back up the existing config (if any) and rewrite from defaults', false)
    .option('--json', 'emit a JSON status object after writing', false)
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
                schemaVersion: '0.1',
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

        if (options.json === true) {
          process.stdout.write(
            `${JSON.stringify({
              schemaVersion: '0.1',
              kind: 'init',
              status: 'written',
              configPath: target,
              provider,
            })}\n`,
          );
        } else {
          process.stdout.write(`Wrote ${target}\n`);
          process.stdout.write(`Default LLM provider: ${provider}\n`);
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
    "  provider: auto # 'auto' | 'tavily' | 'brave' | 'browser'",
    '',
    'retention:',
    '  runsDays: 30',
    '',
  ].join('\n');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
