import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { LocalRunStore } from '@yantra/core/workflow/replay';
import { Command, CommanderError } from 'commander';

import { openHistory, type OpenHistory } from '../history.js';
import { openArtifact } from '../open-artifact.js';
import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';

type Artifact = 'brief' | 'report' | 'audit' | 'dir';
interface OpenOptions {
  readonly artifact?: Artifact;
  readonly print?: boolean;
  readonly json?: boolean;
}

export interface OpenRuntime {
  readonly createRunStore: () => LocalRunStore;
  readonly openHistory: () => Promise<OpenHistory | null>;
  readonly launch: (path: string) => boolean;
}

export function makeOpenCommand(input?: Partial<OpenRuntime>): Command {
  const runtime: OpenRuntime = {
    createRunStore: input?.createRunStore ?? (() => new LocalRunStore()),
    openHistory: input?.openHistory ?? (() => openHistory()),
    launch: input?.launch ?? openArtifact,
  };
  return new Command('open')
    .description("Open a run's saved artifact")
    .argument('[run-id]')
    .option('--artifact <kind>', 'brief | report | audit | dir', 'brief')
    .option('--print', 'print the resolved path without launching', false)
    .option('--json', 'emit JSON without launching', false)
    .action((runId: string | undefined, options: OpenOptions) => runOpen(runId, options, runtime));
}

async function runOpen(
  runId: string | undefined,
  options: OpenOptions,
  runtime: OpenRuntime,
): Promise<void> {
  const artifact = options.artifact ?? 'brief';
  if (!['brief', 'report', 'audit', 'dir'].includes(artifact))
    fail(`unknown artifact "${artifact}"`);
  const store = runtime.createRunStore();
  const selected = runId ? await store.getRun(runId) : await newest(store, runtime);
  if (!selected) fail(runId ? `run "${runId}" was not found` : 'no runs were found');
  const path = await artifactPath(selected.runDir, artifact);
  if (!path) {
    const available = await availableArtifacts(selected.runDir);
    fail(
      `run ${selected.manifest.runId} has no ${artifact} artifact; available: ${available.join(', ') || 'none'}`,
    );
  }
  const body = { runId: selected.manifest.runId, artifact, path };
  if (options.json)
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: 'open', ...body })}\n`,
    );
  else if (options.print) process.stdout.write(`${path}\n`);
  else if (!runtime.launch(path)) fail(`could not launch the default application for ${path}`, 2);
}

async function newest(store: LocalRunStore, runtime: OpenRuntime) {
  const runs = await store.listRuns({ limit: 1 });
  const candidates = runs[0] ? [{ runId: runs[0].runId, startedAt: runs[0].startedAt }] : [];
  const history = await runtime.openHistory();
  if (history) {
    try {
      const listed = await history.store.list({ limit: 1 });
      if (listed.isOk && listed.value[0]) {
        candidates.push({
          runId: listed.value[0].runId,
          startedAt: listed.value[0].startedAt,
        });
      }
    } finally {
      history.close();
    }
  }
  candidates.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  for (const candidate of candidates) {
    const run = await store.getRun(candidate.runId);
    if (run) return run;
  }
  return null;
}

async function artifactPath(runDir: string, artifact: Artifact): Promise<string | null> {
  if (artifact === 'dir') return runDir;
  const candidates =
    artifact === 'brief'
      ? ['brief.html', 'brief.md']
      : artifact === 'report'
        ? ['report.md']
        : ['audit.md', 'audit.json'];
  for (const candidate of candidates) {
    const path = join(runDir, candidate);
    try {
      await access(path);
      return path;
    } catch {
      /* try the next representation */
    }
  }
  return null;
}

async function availableArtifacts(runDir: string): Promise<readonly string[]> {
  try {
    const files = new Set(await readdir(runDir));
    return ['brief.html', 'brief.md', 'report.md', 'audit.md', 'audit.json'].filter((file) =>
      files.has(file),
    );
  } catch {
    return [];
  }
}

function fail(message: string, code = 1): never {
  process.stderr.write(`Error: ${message}\n`);
  throw new CommanderError(code, 'yantra.open.failed', message);
}
