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
cd e2e && npx vitest run task-fidelity    # both spec files: tier + harness self-tests
```

Real Chrome is needed for `client-rendered-listing` and the small challenge variant.
The tier runs in about 20 seconds.

```sh
pnpm eval:tasks                                   # every agentic scenario × 3 runs
pnpm eval:tasks --scenario article-question --runs 1
pnpm eval:tasks --provider anthropic --model <id> --thinking <level> --auth-secret <ref>
pnpm eval:tasks --out <dir> --json                # scorecard JSON on stdout
```

Model selection uses the CLI's own resolver (flag > `YANTRA_AGENT_*` > `profile.yaml` >
pinned default). Missing credentials fail before any fixture server starts:
`AGENT_AUTH_UNAVAILABLE`, exit 3. Each run costs real tokens; the first stderr line
states the plan (`N scenarios × R runs = T agentic runs with <provider>/<model>`).
Output lands in `e2e/task-fidelity/.out/<UTC timestamp>/` (gitignored): `scorecard.json`,
`scorecard.md`, `baseline.json`, and the run directories under `runs/`.

## Layout

| Path                          | What it is                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `fixtures/inventory.ts`       | The truth dataset. Every listing page and every score derives from it.               |
| `fixtures/sites.ts`           | The six patterns, each at `<name>.yantra.test`.                                      |
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

## Fixture patterns

| Site                      | Pattern                                                              | Gap    |
| ------------------------- | -------------------------------------------------------------------- | ------ |
| `faceted-listing`         | Repeated cards, facet links, pagination, detail pages holding colors | G2, G3 |
| `structured-listing`      | The same inventory only as schema.org JSON-LD behind a thin shell    | G2     |
| `client-rendered-listing` | Cards injected by script after load into an empty shell              | G2, G5 |
| `challenge-interstitial`  | HTTP 200 human-verification form; `small` and `large-main` variants  | G10    |
| `article`                 | ~1,600 words of prose with a byline and `datePublished` JSON-LD      | G2     |
| `multi-table`             | The answer sits in the second table                                  | G2     |

Site and brand names may appear only in a page's leading header comment; the census
reuses `SITE_TOKEN_SOURCE` from `eslint.config.js`.

## Expectations and owners

Every deterministic expectation names its owner: `current` (holds today, must keep
holding) or the feature that builds the capability (`FEAT-048`, `FEAT-050`–`FEAT-053`).
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
