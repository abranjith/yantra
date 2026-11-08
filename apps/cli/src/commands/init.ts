import { runInit, type InitAnswerCollector } from '@yantra/core';
import type { Command } from 'commander';

import type {
  ContextGrantAnswers,
  ContextGrantDeps,
} from '../adapters/terminal/init-context-prompts.js';
import type { InitWizardAnswers, InitWizardDeps } from '../adapters/terminal/init-wizard.js';
import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import type { CommandContext } from '../context/command-context.js';
import { resourceOptions } from '../context/resource-options.js';
import { createRegisteredCommand } from '../registry/build-command-tree.js';
import { handler, type Handler } from '../registry/handler.js';
import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';
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
export function makeInitCommand(deps: InitDeps = {}): Command {
  return createRegisteredCommand('init', { init: makeInitHandler(deps) });
}
export function makeInitHandler(
  deps: InitDeps = {},
  context: CommandContext = createTerminalContext(),
): Handler {
  return handler(async (_args, options: InitOptions) => {
    const collector: InitAnswerCollector = {
      providerAnswers: () => (deps.wizard ? deps.wizard() : context.initAnswers.providerAnswers()),
      contextGrants: () => (deps.collect ? deps.collect() : context.initAnswers.contextGrants()),
    };
    const result = await runInit(
      {
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        reset: options.reset === true,
        yes: options.yes === true,
        interactive:
          (deps.isTty ?? context.isInteractive({ json: options.json === true })) &&
          options.json !== true,
      },
      collector,
      { lockOptions: resourceOptions(context, 'init') },
    );
    if (result.status === 'already-initialized') {
      if (options.json)
        context.output.json({
          schemaVersion: CLI_JSON_SCHEMA_VERSION,
          kind: 'init',
          status: result.status,
          configPath: result.configPath,
        });
      else
        context.output.stdout.write(
          `Already initialized at ${result.configPath}. Pass --reset to rewrite.\n`,
        );
      return { exitCode: 0 as const };
    }
    if (result.status === 'invalid-provider') {
      context.output.stderr.write(
        `Unknown provider "${result.provider}" (expected: anthropic | ollama | none)\n`,
      );
      return { exitCode: 1 as const };
    }
    if (result.status === 'failed') {
      context.output.stderr.write(`init failed: ${result.message}\n`);
      return { exitCode: 1 as const };
    }
    if (options.json)
      context.output.json({
        schemaVersion: CLI_JSON_SCHEMA_VERSION,
        kind: 'init',
        status: 'written',
        configPath: result.configPath,
        provider: result.provider,
        searchKey: result.searchKey.status,
      });
    else {
      context.output.stdout.write(`Wrote ${result.configPath}\n`);
      if (result.writingProfile) {
        context.output.stdout.write(`Wrote ${result.profilePath}\n`);
        context.output.stdout.write(
          result.grants.grants.location
            ? 'Location sharing: on. Change it with `yantra prefs set context.location false`.\n'
            : 'Location sharing: off. Change it with `yantra prefs set context.location true`.\n',
        );
      }
      if (result.searchKey.status === 'stored')
        context.output.stdout.write(
          `Stored ${result.searchKey.provider}.api_key in the OS keychain; web search will use ${result.searchKey.provider}.\n`,
        );
      else if (result.searchKey.status === 'manual')
        context.output.stdout.write(
          `The OS keychain is unavailable, so the search key was not stored. Store it later with \`${result.searchKey.command}\`.\n`,
        );
      context.output.stdout.write(
        'Next: yantra model list; yantra secret list; yantra config path\n',
      );
    }

    return { exitCode: 0 as const };
  });
}
