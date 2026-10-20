# FEAT-060 completion audit

Date: 2026-10-20 (America/Chicago).

**Status: all applicable automated gates passed; delivery hooks pending.** The user explicitly waived further OpenCode Go live testing as a feature gate and required all other applicable automated tests to run and succeed. This supersedes the earlier incomplete verdict based on the live sample size.

## Disposition of findings

1. **Live collection: waived by the user.** Collection and automatic retries are stopped and disabled. Four explicitly partial baselines and [benchmark.md](benchmark.md) / [benchmark.json](benchmark.json) preserve 109 measured runs: before/high 36, before/medium 36, after/high 25, and after/medium 12. The remaining 211 runs are waived. This is not evidence that the original live generality or latency targets were achieved; the report records unmet targets and insufficient samples.
2. **Capture-link scorer: fixed.** Current runs must link their screenshot from `Brief.artifacts`; only historical pipelines can fall back to audit references. The regression checks both cases with a real PNG and a schema-valid audit entry. One already-failed retained run had its capture credit corrected from one to zero, without changing true-success, reported-success, or false-fulfilled counts.
3. **Result artifacts and plan entry: completed.** The four partial baseline JSON files are under `e2e/task-fidelity/baselines/2026-10-do-benchmark-partial-*.json`. The governing plan's canonical section 16 records the waiver, per-layout/model counts, p50/p95, false-fulfilled counts, and target verdicts. The benchmark collector, scorer, merger, target evaluator, and CLI remain implemented and tested for future optional use.
4. **Generated review scope: reconciled.** A deterministic comparison against the original Git baseline and current files removed the stale `e2e/task-fidelity-benchmark.spec.ts` entry. Real deletions and all task/role assignments were preserved. Mandatory task and implementation hooks will recapture the final scope; the authoritative list remains `changeset.json`.
5. **Runtime test type coverage: fixed.** TASK-004 explicitly requires checking `tests/runtime`, which the normal agent test TypeScript configuration omitted. The final audit exposed stale fixture types there despite passing runtime tests. The configuration now includes the directory, and the fixtures supply current session, grant, document-store, outcome, census, evidence, and provenance fields. The regular agent type check and lint over the adjusted fixtures pass. Production code, assertions, and compiler strictness were unchanged.

## Validation

- Fresh build: all six workspaces passed without cached execution.
- All-workspace unit and integration tests use `LLM_PROVIDER=none`, one worker, and a 60-second setup-hook allowance. Optional real-browser, recorder migration, input characterization, compatibility, and managed-browser installation suites are enabled against the provisioned Chrome fixture. Protocol: 355 passed; test helpers: 10 passed; core: 3,712 passed across the full run and two focused reruns; agent: 1,433 passed with three POSIX permission tests skipped on Windows; CLI: 605 passed; end-to-end: 841 passed with one live LLM test skipped under the user waiver. In total, 6,956 distinct tests passed across 472 files, with four documented skips. The final end-to-end run passed all 22 files in 1,000.26 seconds, including 589 deterministic task-fidelity acceptance tests and repository formatting/lint smoke checks.
- The initial core run passed 3,710 tests and exposed two setup issues. Building the recorder overlay, as CI does, resolved the popup recording case. The managed-install test now gives its standalone Node child the compiled helper entry instead of a nonexistent JavaScript sibling of the TypeScript source. Both cases passed in focused reruns; the managed-install case downloaded Stable, published it, and launched it. Assertions and deadlines were unchanged. A focused TypeScript check also passed for the adjusted test.
- All twelve repository lint/typecheck jobs passed again after adding runtime test type coverage. All 787 runtime tests passed across 39 files after the fixture corrections, and lint passed over every adjusted fixture. Protocol generated-schema, export, and TypeScript verification passed. The static security boundary check passed over 1,008 files with no violations. The real offline `eval:benchmark` CLI reproduced the retained report's input metadata, cells, and target verdicts from its four partial baselines without provider calls.
- Delivery hooks remain pending; all automated verification is complete.

The final workspace test command used `pnpm.cmd exec turbo run test --concurrency=1 --force --env-mode=loose -- --maxWorkers=1 --minWorkers=1 --hookTimeout=60000`. After the two core setup corrections, the remaining agent, CLI, and end-to-end workspaces were run together with explicit Turbo filters and passed. The affected core cases and all runtime tests were rerun separately as described above; the initial full command is not represented as having passed uninterrupted.

The approved timing deviation is unchanged: retain all seventy controls and the 240-second scenario timeout. The original sixty-second total allowance for the nine new scenarios is not met. Test assertions and individual test deadlines were not weakened.

## Operational cleanup

All live workers and the retry coordinator are stopped. The task-local queues refuse to restart after the waiver. Automatic approval review rejected both deletion of the temporary cohort directory and a narrower deletion of its four named `auth.json` credential copies, reporting that the actions were blocked by policy. Those copies remain under `%TEMP%/yantra-feat060-cohort-homes-20261019`; the user's original secret store was not modified.

No new project-wide memory instruction qualified for capture; the live-test waiver is specific to this feature.
