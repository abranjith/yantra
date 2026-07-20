/** `yantra sites list|add|remove` — inspect and curate local domain ranks. */

import {
  SqliteDomainRankStore,
  normalizeDomain,
  openIndexDb,
  type DomainRankRecord,
  type DomainRankStore,
  type Logger,
} from '@yantra/core';
import { Command, CommanderError } from 'commander';

import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';
import { makeStderrLogger } from '../runtime.js';

interface SitesOptions {
  readonly json?: boolean;
  readonly debug?: boolean;
}

export interface SitesStoreHandle {
  readonly store: DomainRankStore;
  readonly close: () => void;
}

export interface SitesRuntime {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly openStore: (logger: Logger) => Promise<SitesStoreHandle | null>;
}

export function makeSitesCommand(runtime?: Partial<SitesRuntime>): Command {
  const resolved = runtimeWithDefaults(runtime);
  const command = new Command('sites').description('Inspect and curate local website ranks');

  command
    .command('list')
    .description('List ranked domains')
    .option('--json', 'emit JSON', false)
    .option('--debug', 'verbose logging on stderr', false)
    .action(async (options: SitesOptions) => runList(options, resolved));

  command
    .command('add')
    .description('Add or promote a user-curated domain')
    .argument('<domain>', 'hostname such as example.com')
    .option('--json', 'emit JSON', false)
    .option('--debug', 'verbose logging on stderr', false)
    .action(async (domain: string, options: SitesOptions) => runAdd(domain, options, resolved));

  command
    .command('remove')
    .description('Remove a domain from local ranking')
    .argument('<domain>', 'hostname such as example.com')
    .option('--json', 'emit JSON', false)
    .option('--debug', 'verbose logging on stderr', false)
    .action(async (domain: string, options: SitesOptions) => runRemove(domain, options, resolved));

  return command;
}

async function runList(options: SitesOptions, runtime: SitesRuntime): Promise<void> {
  await withStore(options, runtime, (store) => {
    const result = store.list();
    if (!result.isOk) fail(runtime, result.error.message);

    if (options.json === true) {
      emit(runtime, { rows: result.value });
      return;
    }
    if (result.value.length === 0) {
      runtime.stdout.write('No ranked sites yet. Run a web search or `yantra sites add`.\n');
      return;
    }
    renderTable(runtime, result.value);
  });
}

async function runAdd(domain: string, options: SitesOptions, runtime: SitesRuntime): Promise<void> {
  const normalized = validate(domain, runtime);
  await withStore(options, runtime, (store) => {
    const result = store.upsertUserDomain(normalized);
    if (!result.isOk) fail(runtime, result.error.message);
    if (options.json === true) {
      emit(runtime, { status: 'added', record: result.value });
    } else {
      runtime.stdout.write(`Added ${result.value.domain} with rank ${result.value.rank}.\n`);
    }
  });
}

async function runRemove(
  domain: string,
  options: SitesOptions,
  runtime: SitesRuntime,
): Promise<void> {
  const normalized = validate(domain, runtime);
  await withStore(options, runtime, (store) => {
    const result = store.remove(normalized);
    if (!result.isOk) fail(runtime, result.error.message);
    if (!result.value) fail(runtime, `${normalized} is not ranked`);
    if (options.json === true) {
      emit(runtime, { status: 'removed', domain: normalized });
    } else {
      runtime.stdout.write(`Removed ${normalized}.\n`);
    }
  });
}

function validate(input: string, runtime: SitesRuntime): string {
  const result = normalizeDomain(input);
  if (!result.isOk) fail(runtime, result.error.message);
  return result.value;
}

async function withStore(
  options: SitesOptions,
  runtime: SitesRuntime,
  action: (store: DomainRankStore) => void,
): Promise<void> {
  const handle = await runtime.openStore(makeStderrLogger(options.debug === true));
  if (handle === null) fail(runtime, 'site ranking index unavailable — run `yantra doctor`', 3);
  try {
    action(handle.store);
  } finally {
    handle.close();
  }
}

function renderTable(runtime: SitesRuntime, rows: readonly DomainRankRecord[]): void {
  const width = Math.max('Domain'.length, ...rows.map((row) => row.domain.length));
  runtime.stdout.write(`${'Domain'.padEnd(width)}  Rank   +   -  Origin\n`);
  runtime.stdout.write(`${'-'.repeat(width)}  ----  --  --  ------\n`);
  for (const row of rows) {
    runtime.stdout.write(
      `${row.domain.padEnd(width)}  ${String(row.rank).padStart(4)}  ` +
        `${String(row.positiveSignals).padStart(2)}  ${String(row.negativeSignals).padStart(2)}  ` +
        `${row.origin}\n`,
    );
  }
}

function emit(runtime: SitesRuntime, body: Record<string, unknown>): void {
  runtime.stdout.write(
    `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: 'sites', ...body })}\n`,
  );
}

function fail(runtime: SitesRuntime, message: string, exitCode = 1): never {
  runtime.stderr.write(`Error: ${message}\n`);
  throw new CommanderError(exitCode, 'yantra.sites.failed', message);
}

function runtimeWithDefaults(runtime?: Partial<SitesRuntime>): SitesRuntime {
  return {
    stdout: runtime?.stdout ?? process.stdout,
    stderr: runtime?.stderr ?? process.stderr,
    openStore: runtime?.openStore ?? openDefaultStore,
  };
}

async function openDefaultStore(logger: Logger): Promise<SitesStoreHandle | null> {
  try {
    const { db } = await openIndexDb({ logger });
    return {
      store: new SqliteDomainRankStore({ db, logger }),
      close: () => {
        try {
          db.close();
        } catch {
          // Idempotent command teardown.
        }
      },
    };
  } catch {
    return null;
  }
}
