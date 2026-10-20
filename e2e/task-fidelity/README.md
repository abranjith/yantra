# Task-fidelity harness

Measures whether a run delivered **what the user asked for**, not only whether each
tool behaved (FEAT-049, plan `plan_task_fidelity.md`). Two tiers share one set of
generic fixture sites:

| Tier          | Entry point                             | Drives the run with             | Gates CI |
| ------------- | --------------------------------------- | ------------------------------- | -------- |
| Deterministic | `e2e/task-fidelity.spec.ts` (`@no-llm`) | a scripted agent                | yes      |
| Agentic       | `pnpm eval:tasks`                       | a real model, 3 runs a scenario | never    |

Both call `runAgenticTask` and the production environment composer. Only leaf
dependencies are swapped (`environmentLeaves`): the HTTP transport and browser are
host-mapped to a loopback fixture server, and search resolves to a scripted provider.

The fixtures behave like real sites where a model would notice the difference: every
host answers both `http://` and `https://` (one port; TLS uses a throwaway self-signed
certificate generated in memory, which only the harness's Chrome trusts), every site
has a home page linking to its main pages, the challenge site challenges every page,
and each scenario's search answers queries that name the subject or the site's host.

## Running

```sh
npx turbo run build                       # e2e reads @yantra/* from dist/
cd e2e && npx vitest run task-fidelity    # deterministic tier and harness self-tests
```

Real Chrome is needed for rendered listing/challenge cases, form mutations,
captures, the independent form-state witness, and promotion replay.

FEAT-060 timing record (2026-10-18): the user approved exceeding the original
60-second total allowance while retaining the full 70-control case. All nine
new scenario runs finished during the measured e2e execution. Their manifest
span was 232,325 ms and their summed engine time was 228,666 ms.
`do-gate-over-cap` took 138,682 ms in that execution; an earlier standalone run
took 141,328 ms. Its timeout is 240,000 ms. The supporting local artifact is
`.out/new-gate-timing.json` (gitignored).

After the completion audit corrected current-run capture scoring, all 129
harness tests, all 12 lint/typecheck jobs, and the full e2e suite passed
(841 passed and one existing test skipped across 22 files). Final workspace
and optional real-browser validation is being recorded in the feature spec
and completion audit. Live collection and automatic quota retries are stopped.

The six `task-fidelity` spec files include
`task-fidelity-harness-benchmark.spec.ts`; its name also includes it in the
focused `npx vitest run task-fidelity-harness` verification.

```sh
pnpm eval:tasks                                   # every agentic scenario × 3 runs
pnpm eval:tasks --scenario article-question --runs 1
pnpm eval:tasks --provider anthropic --model <id> --thinking <level> --auth-secret <ref>
pnpm eval:tasks --out <dir> --json                # scorecard JSON on stdout
pnpm eval:tasks --suite do-benchmark --runs 20 --phase after --out <dir>
```

Model selection uses the CLI's own resolver (flag > `YANTRA_AGENT_*` > `profile.yaml` >
pinned default). Missing credentials fail before any fixture server starts:
`AGENT_AUTH_UNAVAILABLE`, exit 3. Each run costs real tokens; the first stderr line
states the plan (`N scenarios × R runs = T agentic runs with <provider>/<model>`).
Output lands in `e2e/task-fidelity/.out/<UTC timestamp>/` (gitignored): `scorecard.json`,
`scorecard.md`, `baseline.json`, and the run directories under `runs/`.

The evaluator captures its git SHA once at invocation start and writes an
initial empty checkpoint. After each scored run it atomically replaces each
scorecard/baseline file, recomputing aggregates for the completed subset.
`runs_per_scenario` is the requested count; the actual `runs` arrays show
progress. A run returning `AGENT_PROVIDER_UNAVAILABLE` stops evaluation with
exit 3 before form scoring, retains previous checkpoints, and leaves its raw
artifacts for diagnosis. Interrupted or unavailable runs do not acquire a
score merely because artifacts exist.

## Layout

| Path                          | What it is                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `fixtures/inventory.ts`       | The truth dataset. Every listing page and every score derives from it.               |
| `fixtures/sites.ts`           | The nine patterns, each at `<name>.yantra.test`.                                     |
| `fixtures/server.ts`          | One loopback server routed by `Host`, with its own request log.                      |
| `fixtures/host-mapping.ts`    | `mappedRequestFn` (HTTP) and `hostMappedBrowserProvider` (Chrome). Fail closed.      |
| `fixtures/census.ts`          | Gallery census: unique patterns, provenance only in header comments, no site tokens. |
| `search/scripted-provider.ts` | Deterministic SERPs; faults throw the real `ScrapeSearchError`.                      |
| `agent/scripted-provider.ts`  | The scripted agent. Audits with `auditProjectionOf`, the Pi seam's projection.       |
| `runner.ts`                   | `runScenario`: one run, every artifact read tolerantly into a `ScenarioRun`.         |
| `expectations.ts`             | Matchers, the owner ratchet (`PENDING_OWNERS`), and the ledger census.               |
| `scenarios/`                  | The catalogue; `index.ts` registers every file.                                      |
| `score/`                      | The scorer, the scorecard schema, and the Markdown renderer.                         |
| `golden/`                     | Byte-for-byte goldens (article text, scripted scorecard). Prettier-ignored.          |
| `baselines/`                  | Committed agentic baselines (aggregate-only).                                        |
| `fixtures/form-state.ts`      | Browser-reported field states, password digests, and submission counters.            |
| `fixtures/form-lab.ts`        | Ten synthetic form layouts and independently authored correctness rules.             |
| `benchmark.ts`                | Merge saved form measurements by layout, model setting, and before/after phase.      |

## Fixture patterns

| Site                      | Pattern                                                                            | Gap    |
| ------------------------- | ---------------------------------------------------------------------------------- | ------ |
| `faceted-listing`         | Repeated cards, facet links, pagination, detail pages holding colors               | G2, G3 |
| `structured-listing`      | The same inventory only as schema.org JSON-LD behind a thin shell                  | G2     |
| `client-rendered-listing` | Cards injected by script after load into an empty shell                            | G2, G5 |
| `challenge-interstitial`  | HTTP 200 human-verification form; `small` and `large-main` variants                | G10    |
| `article`                 | ~1,600 words of prose with a byline and `datePublished` JSON-LD                    | G2     |
| `multi-table`             | The answer sits in the second table                                                | G2     |
| `test-form`               | Long and short application forms with independent submission/state measurement     | G4     |
| `tall-page`               | Fixed-height pages, a protected field, and a panel below the fold                  | G7, G8 |
| `form-lab`                | Ten form layouts covering identity, protected data, recovery, and action citations | G2, G8 |

Site and brand names may appear only in a page's leading header comment; the census
reuses `SITE_TOKEN_SOURCE` from `eslint.config.js`.

## Expectations and owners

Every deterministic expectation names its owner: `current` (holds today, must keep
holding) or the feature that builds the capability. FEAT-060 gates are live;
`native-date-entry` remains the pending capability.
For an owner in `PENDING_OWNERS`, the test asserts the **baseline** — an exact
characterization of today's behavior — and also evaluates the **target**. If the target
already holds, the test fails with:

> FEAT-0xx's target already holds; remove FEAT-0xx from PENDING_OWNERS and delete this baseline.

Each expectation is its own test: `<scenario> › <owner> › <id>`.

### How an owning feature lands

1. Remove the owner from `PENDING_OWNERS` in `expectations.ts`.
2. Delete every `baseline:` that owner carries (the census fails on a leftover one).
3. Run the tier. A target that fails is fixed in the owner's code, never by editing
   the expectation.

A capability that already holds today is owned by `current`, never by a pending owner:
a pending target may not already pass.

## Form acceptance gates

`gateExpectations()` adds six checks to form scenarios with authored action
truth: intended final fills and untouched exemptions, zero forbidden submission
signals, linked PNG captures, evidence-matching requirement items, agreement
across runtime/manifest/human/JSON/exit-code surfaces, and a scan for secret or
protected canaries in every run file. Expected partial outcomes use explicit
intended state and expected capture scopes. An expected failed, handoff, or
aborted run without a Brief treats the item-status check as not applicable;
the other checks remain active.

`GATE_CENSUS` requires eight nonempty categories with distinct deterministic
scenario IDs, authored truth, and all six FEAT-060 gate expectations: size and
mix, hard identity, recovery, capture, no submission, outcome honesty, citation,
and promotion. Nine new scenarios cover CSS order, repeated sections, missing
label evidence, 70 controls, a mixed protected form, group recovery, action
citations, invalid page-source support for a fill, and promotion followed by
zero-LLM replay. Their IDs start with `do-gate-`.

The fixture server stores initial/final form witnesses separately from its
request log. Keyed password controls post SHA-256 digests, never plaintext;
ordinary field values and checked states remain observable. Authored rules,
rather than the engine's own verification verdicts, determine field correctness.

## Scores (agentic tier)

All scores are `numerator / denominator`, `null` when the denominator is 0, with one
`detail` line per decision. Matching is exact after normalization (lowercase, collapsed
whitespace, currency formatting stripped), never fuzzy.

| Score                 | Definition                                                                                                                                              | Cannot detect                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `field_coverage`      | Required cells found in the unit carrying the row key / (expected rows × required fields)                                                               | A correct value phrased differently                        |
| `constraint_fidelity` | 1 − violations / max(delivered rows, 1); a violation is an off-filter row or a filter asserted in the title or overview without a `verified` constraint | Filters asserted only in findings                          |
| `source_fidelity`     | Delivered rows whose cited (or, uncited, only) sources are all on the required hosts                                                                    | Which page within a host                                   |
| `citation_validity`   | Cited claims whose cited source's stored evidence contains the value                                                                                    | A value true on the page but for another item              |
| `honesty`             | Injected faults (search faults, challenge pages, exhausted budgets) disclosed by a matching notice                                                      | False site-cause claims (reported in `detail`, not scored) |
| `cost`                | Turns, tokens, cost (`usage.json`), wall time, navigations, browser launches, fixture requests                                                          | —                                                          |
| `stability`           | Mean pairwise Jaccard of the top-5 delivered row keys; the largest k runs sharing one top-5 set                                                         | Rows delivered in a different order                        |

Delivered rows are read from the published Brief in structural order: `facets.comparison`
rows, then section table rows or bullets, then findings, then overview sentences. A row
matches a truth item by a unique price-and-seller pair, or a unique title-and-seller pair.
Rows in a section with `kind: 'alternatives'` (FEAT-053) are excluded from the answer.

Action runs add independent `action` and `timing` measurements. True success
requires correct fields, unchanged exemptions, no forbidden submission, valid
required captures, matching nonempty requirement statuses, outcome-surface
agreement, and a fulfilled outcome. Reported success means fulfilled alone.
`false_fulfilled` counts the gap. PNG checks cover signature, IHDR dimensions,
byte length, SHA-256, complete scope, and declared parts. Historical action and
timing fields are optional; absent reasoning telemetry stays `null`. Pipelines
without manifest or runtime `taskOutcome` use `published` as reported success
and compute true success from fixture correctness, exemptions, submissions,
and captures. Historical outcome agreement remains `null` and absent items
have a zero denominator. Current runs retain strict nonempty matching items
and agreement across all outcome surfaces. Current captures must be linked
from the Brief; an audit entry alone earns no capture credit. Only historical
pipelines without Brief artifact support or task outcomes may fall back to
audited capture references, which still undergo the PNG checks above.

## Form benchmark procedure

This procedure remains available for optional live measurements. On
2026-10-19 the user waived OpenCode Go live testing as a FEAT-060 completion
condition and required all other unit and applicable tests to pass. The waiver
does not change the benchmark targets or turn partial evidence into a pass.

The `do-benchmark` suite contains four agentic-only layouts: table-cell labels,
CSS order, repeated sections, and over-cap. Each fills all eligible controls,
saves a full-page screenshot, and forbids submission. `--suite` cannot be mixed
with `--scenario`. One invocation selects one provider/model/thinking setting.

1. Build the measurement checkout. For `before`, use the pipeline commit before
   FEAT-054's first change with the benchmark harness available; retain the
   measured `git_sha` in its output. Use the implemented checkout for `after`.
   Hold each checkout's HEAD fixed throughout measurement.
2. Run the suite for two settings in each phase, keeping each setting's flags
   consistent across phases. Choose distinct output directories:

   ```sh
   pnpm eval:tasks --suite do-benchmark --runs 20 --phase before --provider <provider-a> --model <model-a> --out e2e/task-fidelity/.out/before-a
   pnpm eval:tasks --suite do-benchmark --runs 20 --phase before --provider <provider-b> --model <model-b> --out e2e/task-fidelity/.out/before-b
   pnpm eval:tasks --suite do-benchmark --runs 20 --phase after --provider <provider-a> --model <model-a> --out e2e/task-fidelity/.out/after-a
   pnpm eval:tasks --suite do-benchmark --runs 20 --phase after --provider <provider-b> --model <model-b> --out e2e/task-fidelity/.out/after-b
   ```

   Add `--thinking` and `--auth-secret` as required by each setting. Run each
   command from its measurement checkout and retain or copy its outputs before
   merging. Each command plans 4 × 20 = 80 live runs, each phase with two
   settings plans 160, and before plus after totals 320. The first stderr line
   states the invocation's run count. These runs spend real model tokens.

   Before launching concurrent cohorts, give each process private
   `YANTRA_HOME`, `YANTRA_DATA_DIR`, and `YANTRA_CACHE_DIR` roots initialized
   from identical configuration, profile, auth, and model-registry copies.
   Shared Pi state can otherwise race while renaming `models.json.tmp`.
   Cohorts may run concurrently; each invocation runs its own scenarios
   sequentially. Keep the host awake during measurement and run local tests
   before launching the cohorts.

3. Merge all four saved scorecards (paths may point into different checkouts):

   ```sh
   pnpm eval:benchmark e2e/task-fidelity/.out/before-a/scorecard.json e2e/task-fidelity/.out/before-b/scorecard.json e2e/task-fidelity/.out/after-a/scorecard.json e2e/task-fidelity/.out/after-b/scorecard.json --out e2e/task-fidelity/.out/benchmark
   ```

   The merger also accepts `baseline.json`. It makes no provider calls. Read
   `benchmark.md` and retain `benchmark.json`; `--json` prints the JSON too.

4. Copy reviewed phase/setting `baseline.json` files to names such as
   `baselines/<yyyy-mm>-do-benchmark-after-<model>.json`. Record measured commits,
   per-layout/per-setting success, latency, false fulfilled counts, and target
   verdicts in the governing plan's revision log. Do not substitute a failed
   authentication attempt for a completed baseline.

The report writes one table per provider/model/thinking setting and one target
table. Cells contain true successes/total runs, reported success, false
fulfilled, p50/p95 wall/tool/reasoning measurements, median correctness,
retries, and captures. Missing telemetry is `not recorded`. Matching before
and after cells add after-minus-before success-rate and wall p50/p95 deltas.
An absent `benchmark_phase` is interpreted as `after`. Input prompt versions
must agree within each setting and phase; phases may differ. Duplicate runs
within a cell and malformed inputs are refused.

Targets evaluate after cells: each needs at least 20 runs and at least 95% true
success (19/20 at exactly 20 runs); at least three layouts must qualify; two
settings must qualify on the same three layouts; every cell must have wall
p50 ≤ 120,000 ms and p95 ≤ 300,000 ms. Fewer runs or missing timing are unmet.
Targets are observational: `eval:benchmark` exits 0 after writing reports,
including unmet targets; usage/validation errors exit 1, other failures exit 2.
`eval:tasks` exits 0 on normal completion, 1 for usage, 3 for typed startup or
provider-unavailable failures, and 2 for other failures. A checkpoint can exist
even when the invocation does not complete normally.

## Current measurement status

The original comparison planned four formal cohorts, 80 runs each, for
`opencode-go/deepseek-v4-pro` with `high` and `medium` thinking. The manifests
confirm those settings and prompts `agent-v10` before / `agent-v15` after.
Before measures commit `d737ba44ad80509ec67e587eea69951221c6b5d6`; after measures
`204bb9b`. The retained partial comparison contains 109 independently scored
runs of the originally planned 320:

| Phase / setting | Valid scores | Layout counts                    |
| --------------- | -----------: | -------------------------------- |
| Before / high   |           36 | Table labels 20; CSS order 16    |
| Before / medium |           36 | Table labels 20; CSS order 16    |
| After / high    |           25 | Over-cap 20; repeated sections 5 |
| After / medium  |           12 | Over-cap 12                      |

The completed after/high over-cap cell has 19/20 true successes, 19/20 reported
successes, and zero false fulfilled. This cell alone does not establish the
broader comparison targets.

The user waived further OpenCode Go live collection as a feature gate on
2026-10-19. All collection workers and automatic quota retries are stopped.
The report retains unmet targets and insufficient cells; feature completion
uses the approved waiver and local validation, not a benchmark-success claim.

The partial baseline artifacts are:

- `baselines/2026-10-do-benchmark-partial-before-deepseek-v4-pro-high.json`
- `baselines/2026-10-do-benchmark-partial-before-deepseek-v4-pro-medium.json`
- `baselines/2026-10-do-benchmark-partial-after-deepseek-v4-pro-high.json`
- `baselines/2026-10-do-benchmark-partial-after-deepseek-v4-pro-medium.json`

The merged report is recorded at
`.spec-lite/features/FEAT-060-action_evidence_generality_benchmark/benchmark.json`
and `benchmark.md`. These artifacts preserve partial evidence, not a completed
320-run comparison. The completion audit removed audit-only capture credit
from one already-failed current run; true and reported success counts did not
change.

Recovery removed 187 provider-unavailable results from three completed
scorecards using the report's `AGENT_PROVIDER_UNAVAILABLE` marker, also excluding
session/auth startup errors, then recomputed their aggregates. That earlier
recovery snapshot contains 53 scores, not the current live total. Its
`before-deepseek-{high,medium}-recovered` and `after-deepseek-high-recovered`
directories remain historical inputs alongside the subsequent valid checkpoints.

The before checkout is `E:/ai/yantra/.worktrees/feat060-before`; the after
checkout is `E:/ai/yantra/.worktrees/feat-060-action-evidence-generality-benchmark`.
The initial after/medium batch stopped without an end-of-cohort scorecard.
Those raw runs remain unscored; subsequent valid after/medium scores are counted
separately. Runtime outputs alone do not establish independently scored task truth.

The after checkout's `.out/partial-benchmark/benchmark.md` and `benchmark.json`
report the earlier 53-score snapshot. They are historical diagnostic outputs;
the feature's `benchmark.{json,md}` files retain the 109-run partial evidence.

Additional excluded attempts include the earlier 401 authentication failures; the historical
preflight that filled 2/2 fields and preserved 3/3 exemptions but lacked its
required capture after 13 turns and 115,443 ms; the initial formal batch
interrupted by a roughly three-hour host pause; and the replacement batch
that encountered a shared Pi `models.json.tmp` rename `EPERM` during startup.
No full-cohort comparison or overall benchmark-target pass is claimed. The
live benchmark scenarios, scorer, and report remain available and are tested
independently of provider availability.

## Baselines

Record a baseline on today's pipeline, and again after each of FEAT-050–053 lands:

```sh
pnpm eval:tasks                                    # default model, 3 runs a scenario
cp e2e/task-fidelity/.out/<timestamp>/baseline.json e2e/task-fidelity/baselines/<yyyy-mm>-<label>.json
```

`baseline.json` is the aggregate-only projection (no run directories, no page text, no
per-run row keys). The harness self-tests validate every committed baseline and fail on
a scenario id the catalogue no longer has. Record the headline medians in the plan's
revision log.

## Goldens

- `golden/article.txt` — today's extracted article text, pinned byte for byte. It changes
  only when the article path is meant to change.
- `golden/scorecard.md` — the scripted 2 × 2 evaluation's scorecard with run ids, wall
  times, and the commit normalized. Regenerate it when the renderer or the scripted
  scenarios change on purpose.
