// @no-llm
/**
 * The replay Synthesize stage (FEAT-FP-001, TASK-005).
 *
 * The load-bearing property under test is containment: this stage may add a
 * Brief to a run, and may never take a successful run away.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Brief, Result, WorkflowSynthesis } from '@yantra/protocol';
import { createBrief, err, ok, validateBrief } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../../src/browser/types.js';
import type { ReplayEvidenceEntry } from '../../../src/executor/evidence-ledger.js';
import { DeterministicSynthesizer } from '../../../src/synthesis/deterministic.js';
import { SynthesisError } from '../../../src/synthesis/types.js';
import type {
  SynthesisInput,
  SynthesisOptions,
  SynthesisOutcome,
  Synthesizer,
} from '../../../src/synthesis/types.js';
import {
  runSynthesizeStage,
  synthesizeGate,
  synthesizeRun,
  toSynthesisSpec,
  type SynthesisSpec,
  type SynthesisStrategies,
} from '../../../src/workflow/replay/synthesize.js';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const TASK_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const spec: SynthesisSpec = {
  goal: 'What did the quarterly report say about revenue?',
  length: 'medium',
  detail: 'standard',
  useLlm: false,
};

/** The same intent, but declaring that a model should write the document. */
const llmSpec: SynthesisSpec = { ...spec, useLlm: true };

/** The protocol-shaped block as it appears in a workflow file. */
const block: WorkflowSynthesis = {
  goal: spec.goal,
  length: 'medium',
  detail: 'standard',
  use_llm: false,
};

function entry(overrides: Partial<ReplayEvidenceEntry> = {}): ReplayEvidenceEntry {
  return {
    url: 'https://example.com/investors',
    finalUrl: null,
    host: 'example.com',
    title: 'Investor relations',
    text:
      'Revenue rose 12% year over year to $4.2 billion in the third quarter. ' +
      'Operating margin held at 21%. The company reaffirmed its full-year outlook. ' +
      'Management cited stronger demand in the enterprise segment.',
    fetchedAt: '2026-07-28T12:00:00.000Z',
    stepId: 's2',
    ...overrides,
  };
}

/** A synthesizer that records its inputs and returns a canned Brief. */
function spySynthesizer(strategy: 'deterministic' | 'llm'): Synthesizer & {
  readonly calls: { input: SynthesisInput; opts: SynthesisOptions }[];
} {
  const calls: { input: SynthesisInput; opts: SynthesisOptions }[] = [];
  return {
    strategy,
    calls,
    synthesize: (
      input: SynthesisInput,
      opts: SynthesisOptions,
    ): Promise<Result<SynthesisOutcome, SynthesisError>> => {
      calls.push({ input, opts });
      const brief: Brief = createBrief({
        task_id: opts.taskId,
        title: `${strategy} brief`,
        overview: 'An overview.',
        metadata: { synthesis: strategy, run_id: opts.runId },
      });
      return Promise.resolve(
        ok({
          brief,
          verdict: { claimsChecked: 0, flagged: 0, stripped: 0 },
          strategyUsed: strategy,
          fallbackUsed: false,
        }),
      );
    },
  };
}

/** The LLM strategy is supplied as a per-run factory; wrap an instance for tests. */
function llmFactory(synthesizer: Synthesizer): SynthesisStrategies['llm'] {
  return () => synthesizer;
}

function strategies(
  overrides: Partial<Omit<SynthesisStrategies, 'llm'>> & { llm?: Synthesizer | null } = {},
): SynthesisStrategies {
  const { llm, ...rest } = overrides;
  return {
    deterministic: new DeterministicSynthesizer(),
    llm: llm === undefined || llm === null ? null : llmFactory(llm),
    noLlm: false,
    ...rest,
  };
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    spec,
    evidence: [entry()],
    overflowCount: 0,
    scope: 'public' as const,
    taskId: TASK_ID,
    runId: 'run-1',
    runDir: '/runs/run-1',
    strategies: strategies(),
    ...overrides,
  };
}

describe('@no-llm toSynthesisSpec', () => {
  it('projects the workflow block onto the stage spec', () => {
    expect(toSynthesisSpec(block)).toEqual(spec);
  });

  it('carries use_llm through as the stage-level intent', () => {
    expect(toSynthesisSpec({ ...block, use_llm: true })).toEqual(llmSpec);
  });
});

describe('@no-llm synthesizeGate', () => {
  const all = { synthesisSpec: block, strategies: strategies(), completed: true };

  it('runs and narrows its inputs when every condition holds', () => {
    const gate = synthesizeGate(all);

    expect(gate.run).toBe(true);
    expect(gate.run && gate.spec).toEqual(spec);
    expect(gate.run && gate.strategies).not.toBeNull();
  });

  it('skips the stage entirely when the workflow declares no synthesis', () => {
    expect(synthesizeGate({ ...all, synthesisSpec: null }).run).toBe(false);
  });

  it('skips the stage when the caller wired no strategies', () => {
    expect(synthesizeGate({ ...all, strategies: null }).run).toBe(false);
  });

  it('skips the stage for a run that did not complete', () => {
    expect(synthesizeGate({ ...all, completed: false }).run).toBe(false);
  });
});

describe('@no-llm synthesizeRun', () => {
  it('produces a schema-valid Brief on the deterministic path with no LLM wired', async () => {
    const outcome = await synthesizeRun(baseOptions(), logger);

    expect(outcome).not.toBeNull();
    expect(outcome?.strategyUsed).toBe('deterministic');
    expect(outcome?.fallbackUsed).toBe(false);
    expect(validateBrief(outcome?.brief).isOk).toBe(true);
  });

  it('turns ledger entries into contiguously numbered sources', async () => {
    const outcome = await synthesizeRun(
      baseOptions({
        evidence: [
          entry({
            url: 'https://a.test/1',
            host: 'a.test',
            title: 'A',
            text:
              'Revenue rose 12% year over year to $4.2 billion in the third quarter. ' +
              'Operating margin held at 21%.',
          }),
          entry({
            url: 'https://b.test/2',
            host: 'b.test',
            title: 'B',
            text:
              'Analysts noted the quarterly revenue beat consensus by roughly $150 million. ' +
              'Subscription revenue contributed the largest share of the increase, ' +
              'while hardware revenue was flat against the prior quarter.',
          }),
        ],
      }),
      logger,
    );

    const sources = outcome?.brief.sources ?? [];
    expect(sources.map((source) => source.n)).toEqual([1, 2]);
    expect(sources.map((source) => source.host)).toEqual(['a.test', 'b.test']);
    expect(sources.map((source) => source.url)).toEqual(['https://a.test/1', 'https://b.test/2']);
    expect(sources.map((source) => source.title)).toEqual(['A', 'B']);
  });

  it('merges near-duplicate reads into one numbered source', async () => {
    // A loop that re-reads the same content on two URLs must not inflate
    // apparent cross-source support; the shared clustering stage handles this
    // and the replay stage inherits it for free.
    const outcome = await synthesizeRun(
      baseOptions({
        evidence: [
          entry({ url: 'https://a.test/1', host: 'a.test' }),
          entry({ url: 'https://mirror.test/1', host: 'mirror.test' }),
        ],
      }),
      logger,
    );

    expect(outcome?.brief.sources).toHaveLength(1);
  });

  it('carries the ledger fetchedAt onto the source rather than wall time', async () => {
    const outcome = await synthesizeRun(
      baseOptions({ evidence: [entry({ fetchedAt: '2026-01-02T03:04:05.000Z' })] }),
      logger,
    );

    expect(outcome?.brief.sources[0]?.fetched_at).toBe('2026-01-02T03:04:05.000Z');
  });

  it('maps the spec goal to the query and the spec budgets to the options', async () => {
    const deterministic = spySynthesizer('deterministic');

    await synthesizeRun(
      baseOptions({
        spec: { goal: 'the question', length: 'long', detail: 'full', useLlm: false },
        strategies: strategies({ deterministic }),
      }),
      logger,
    );

    expect(deterministic.calls[0]?.input.query).toBe('the question');
    expect(deterministic.calls[0]?.opts).toMatchObject({
      length: 'long',
      detail: 'full',
      scope: 'public',
      taskId: TASK_ID,
      runId: 'run-1',
      searchProvider: null,
    });
  });

  it('selects the LLM strategy when the workflow declared useLlm and a port is wired', async () => {
    const llm = spySynthesizer('llm');

    const outcome = await synthesizeRun(
      baseOptions({ spec: llmSpec, strategies: strategies({ llm, noLlm: false }) }),
      logger,
    );

    expect(llm.calls).toHaveLength(1);
    expect(outcome?.strategyUsed).toBe('llm');
  });

  it('stays deterministic when the workflow did not declare useLlm, port or no port', async () => {
    // The central UX property: wiring a port is the CLI saying "a model is
    // available", never "use one". Only the workflow opts in.
    const llm = spySynthesizer('llm');
    const deterministic = spySynthesizer('deterministic');

    const outcome = await synthesizeRun(
      baseOptions({ strategies: { deterministic, llm: llmFactory(llm), noLlm: false } }),
      logger,
    );

    expect(llm.calls).toHaveLength(0);
    expect(deterministic.calls).toHaveLength(1);
    expect(outcome?.strategyUsed).toBe('deterministic');
    // Not a degradation — nobody asked for a model — so no fallback is recorded.
    expect(outcome?.fallbackUsed).toBe(false);
  });

  it('never constructs the LLM strategy for a workflow that did not declare useLlm', async () => {
    // The factory exists precisely so an ordinary replay pays nothing for the
    // provider adapter it will not use.
    const build = vi.fn(() => spySynthesizer('llm'));

    await synthesizeRun(
      baseOptions({
        strategies: { deterministic: new DeterministicSynthesizer(), llm: build, noLlm: false },
      }),
      logger,
    );

    expect(build).not.toHaveBeenCalled();
  });

  it('forces the deterministic strategy when noLlm vetoes a workflow that declared useLlm', async () => {
    const llm = spySynthesizer('llm');
    const deterministic = spySynthesizer('deterministic');

    const outcome = await synthesizeRun(
      baseOptions({
        spec: llmSpec,
        strategies: { deterministic, llm: llmFactory(llm), noLlm: true },
      }),
      logger,
    );

    expect(llm.calls).toHaveLength(0);
    expect(deterministic.calls).toHaveLength(1);
    expect(outcome?.strategyUsed).toBe('deterministic');
  });

  it('never even constructs the LLM strategy when noLlm vetoes the run', async () => {
    const build = vi.fn(() => spySynthesizer('llm'));

    await synthesizeRun(
      baseOptions({
        spec: llmSpec,
        strategies: { deterministic: new DeterministicSynthesizer(), llm: build, noLlm: true },
      }),
      logger,
    );

    expect(build).not.toHaveBeenCalled();
  });

  it('builds the LLM strategy with the run id and directory', async () => {
    const build = vi.fn(() => spySynthesizer('llm'));

    await synthesizeRun(
      baseOptions({
        spec: llmSpec,
        runId: 'run-42',
        runDir: '/runs/run-42',
        strategies: { deterministic: new DeterministicSynthesizer(), llm: build, noLlm: false },
      }),
      logger,
    );

    expect(build).toHaveBeenCalledWith({ runId: 'run-42', runDir: '/runs/run-42' });
  });

  it('keeps an authenticated-scope workflow deterministic even when it declared useLlm', async () => {
    const llm = spySynthesizer('llm');
    const deterministic = spySynthesizer('deterministic');

    await synthesizeRun(
      baseOptions({
        spec: llmSpec,
        scope: 'authenticated',
        strategies: { deterministic, llm: llmFactory(llm), noLlm: false },
      }),
      logger,
    );

    expect(llm.calls).toHaveLength(0);
    expect(deterministic.calls).toHaveLength(1);
  });

  it('falls back to the deterministic Brief when the LLM strategy cannot be built', async () => {
    // The one LLM failure the synthesizer's own fallback cannot cover: the
    // adapter throws before a synthesizer exists. The run must still get its
    // document.
    const deterministic = spySynthesizer('deterministic');
    const build = vi.fn(() => {
      throw new Error('provider binary missing');
    });

    const outcome = await synthesizeRun(
      baseOptions({ spec: llmSpec, strategies: { deterministic, llm: build, noLlm: false } }),
      logger,
    );

    expect(deterministic.calls).toHaveLength(1);
    expect(outcome?.strategyUsed).toBe('deterministic');
    expect(outcome?.fallbackUsed).toBe(true);
  });

  it('logs a warning naming the reason the LLM strategy was unavailable', async () => {
    const warn = vi.fn();
    const build = vi.fn(() => {
      throw new Error('provider binary missing');
    });

    await synthesizeRun(
      baseOptions({
        spec: llmSpec,
        strategies: { deterministic: new DeterministicSynthesizer(), llm: build, noLlm: false },
      }),
      { ...logger, warn },
    );

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'provider binary missing' }),
      expect.stringContaining('could not construct the llm strategy'),
    );
  });

  it('falls back and records it when the workflow declared useLlm but no port is wired', async () => {
    // e.g. a stage wired without a port for a workflow that wants one. The run
    // keeps its Brief, and the manifest stays honest about the downgrade so
    // `resume` can re-offer the model.
    const deterministic = spySynthesizer('deterministic');
    const warn = vi.fn();

    const outcome = await synthesizeRun(
      baseOptions({ spec: llmSpec, strategies: { deterministic, llm: null, noLlm: false } }),
      { ...logger, warn },
    );

    expect(outcome?.strategyUsed).toBe('deterministic');
    expect(outcome?.fallbackUsed).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('preserves a fallback the LLM synthesizer already reported', async () => {
    // The synthesizer's own provider failure path — already covered by
    // `LlmSynthesizer` — must not be double-counted or overwritten.
    const fallingBack: Synthesizer = {
      strategy: 'llm',
      synthesize: (_input, opts) =>
        Promise.resolve(
          ok({
            brief: createBrief({ task_id: opts.taskId, title: 't', overview: 'o' }),
            verdict: { claimsChecked: 0, flagged: 0, stripped: 0 },
            strategyUsed: 'deterministic' as const,
            fallbackUsed: true,
          }),
        ),
    };

    const outcome = await synthesizeRun(
      baseOptions({ spec: llmSpec, strategies: strategies({ llm: fallingBack }) }),
      logger,
    );

    expect(outcome?.strategyUsed).toBe('deterministic');
    expect(outcome?.fallbackUsed).toBe(true);
  });

  it('reports ledger overflow as an honest extract_failed notice', async () => {
    const outcome = await synthesizeRun(baseOptions({ overflowCount: 7 }), logger);

    const notices = outcome?.brief.notices ?? [];
    expect(notices.some((notice) => notice.kind === 'extract_failed')).toBe(true);
    expect(notices.some((notice) => notice.reason.includes('7 recorded read(s)'))).toBe(true);
  });

  it('adds no overflow notice when nothing was dropped', async () => {
    const outcome = await synthesizeRun(baseOptions({ overflowCount: 0 }), logger);

    expect(
      (outcome?.brief.notices ?? []).some((notice) => notice.reason.includes('evidence-ledger')),
    ).toBe(false);
  });

  it('forwards caller-supplied step failures as notices', async () => {
    const outcome = await synthesizeRun(
      baseOptions({
        failures: [
          { url: 'https://slow.test/', host: 'slow.test', stage: 'fetch', reason: 'timed out' },
        ],
      }),
      logger,
    );

    const notices = outcome?.brief.notices ?? [];
    expect(notices.some((notice) => notice.kind === 'fetch_failed')).toBe(true);
  });

  it('returns null and logs when the synthesizer reports an error', async () => {
    const failing: Synthesizer = {
      strategy: 'deterministic',
      synthesize: () =>
        Promise.resolve(
          err(new SynthesisError('no evidence', { query: 'q', strategy: 'deterministic' })),
        ),
    };

    const outcome = await synthesizeRun(
      baseOptions({ strategies: strategies({ deterministic: failing }) }),
      logger,
    );

    expect(outcome).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns null rather than throwing when the synthesizer throws', async () => {
    const throwing: Synthesizer = {
      strategy: 'deterministic',
      synthesize: () => {
        throw new Error('contract violation');
      },
    };

    const outcome = await synthesizeRun(
      baseOptions({ strategies: strategies({ deterministic: throwing }) }),
      logger,
    );

    expect(outcome).toBeNull();
  });

  it('still produces a Brief when the ledger is empty', async () => {
    const outcome = await synthesizeRun(baseOptions({ evidence: [] }), logger);

    // No sources to cite, but the document must still be schema-valid rather
    // than a crash or a null.
    if (outcome !== null) {
      expect(validateBrief(outcome.brief).isOk).toBe(true);
      expect(outcome.brief.sources).toEqual([]);
    }
  });
});

describe('@no-llm runSynthesizeStage', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-synth-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('writes brief.json, brief.md, and brief.html into the run dir', async () => {
    const stage = await runSynthesizeStage({ ...baseOptions(), runDir }, logger);

    expect(stage.brief).not.toBeNull();
    expect(stage.artifacts).not.toBeNull();
    expect(stage.artifacts?.jsonPath).toBe(join(runDir, 'brief.json'));
    expect(stage.artifacts?.mdPath).toBe(join(runDir, 'brief.md'));
    expect(stage.artifacts?.htmlPath).toBe(join(runDir, 'brief.html'));

    const written = JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8')) as unknown;
    expect(validateBrief(written).isOk).toBe(true);
    await expect(readFile(join(runDir, 'brief.md'), 'utf8')).resolves.toContain('#');
    await expect(readFile(join(runDir, 'brief.html'), 'utf8')).resolves.toContain('<');
  });

  it('records the manifest provenance with the brief.json path', async () => {
    const stage = await runSynthesizeStage({ ...baseOptions(), runDir }, logger);

    expect(stage.record).toEqual({
      strategy: 'deterministic',
      fallbackUsed: false,
      briefPath: join(runDir, 'brief.json'),
    });
  });

  it('records fallbackUsed when the LLM path degraded', async () => {
    const fallingBack: Synthesizer = {
      strategy: 'llm',
      synthesize: (_input, opts) =>
        Promise.resolve(
          ok({
            brief: createBrief({
              task_id: opts.taskId,
              title: 'fallback',
              overview: 'o',
              metadata: { synthesis: 'deterministic', deterministic_fallback_used: true },
            }),
            verdict: { claimsChecked: 0, flagged: 0, stripped: 0 },
            strategyUsed: 'deterministic' as const,
            fallbackUsed: true,
          }),
        ),
    };

    const stage = await runSynthesizeStage(
      {
        ...baseOptions({ spec: llmSpec, strategies: strategies({ llm: fallingBack }) }),
        runDir,
      },
      logger,
    );

    expect(stage.record).toMatchObject({ strategy: 'deterministic', fallbackUsed: true });
  });

  it('returns an all-null result when synthesis produced nothing', async () => {
    const failing: Synthesizer = {
      strategy: 'deterministic',
      synthesize: () =>
        Promise.resolve(err(new SynthesisError('nope', { query: 'q', strategy: 'deterministic' }))),
    };

    const stage = await runSynthesizeStage(
      { ...baseOptions({ strategies: strategies({ deterministic: failing }) }), runDir },
      logger,
    );

    expect(stage).toEqual({ brief: null, artifacts: null, record: null });
  });

  it('keeps the Brief when the artifact write fails', async () => {
    // A file where the run directory should be makes every write under it fail.
    const blocked = join(runDir, 'blocked');
    await writeFile(blocked, 'not a directory', 'utf8');

    const stage = await runSynthesizeStage({ ...baseOptions(), runDir: blocked }, logger);

    expect(stage.brief).not.toBeNull();
    expect(stage.artifacts).toBeNull();
    expect(stage.record).toMatchObject({ briefPath: null });
    expect(logger.warn).toHaveBeenCalled();
  });
});
