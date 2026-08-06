# Yantra

AI-orchestrated browser automation platform with a TypeScript monorepo foundation.

## Prerequisites

- Node v24.15.0 LTS
- pnpm (workspace uses packageManager from [package.json](package.json))
- System Chrome (used by later features)

## Quickstart

```bash
pnpm install
pnpm test
```

### First run

`yantra init` writes `~/.config/yantra/config.yaml` and seeds your
`profile.yaml`. On an interactive terminal it asks one short question — whether
the agent may be told your location, and if so, your city or area — and records
the answer as a grant you can change at any time.

```bash
yantra init                      # asks; writes both files
yantra init --yes                # accept defaults without prompting
yantra init --json               # machine-readable; never prompts
yantra init --reset              # back up and rewrite, asking again
```

**Scripted and CI use is unaffected.** The question fires only on an interactive
TTY, without `--json` or `--yes`, and only when the profile is actually being
written (absent, or `--reset`) — a non-TTY implies `--yes`. Every other path
writes the defaults silently, and the defaults are behavior-preserving: the
grant starts `true` with no city set, which reads to the agent as
"not available".

## Commands

| Command            | Description                        |
| ------------------ | ---------------------------------- |
| `pnpm build`       | Build all workspaces via Turborepo |
| `pnpm test`        | Run all workspace test suites      |
| `pnpm test:no-llm` | Run tests with `LLM_PROVIDER=none` |
| `pnpm lint`        | Lint the full repository           |
| `pnpm typecheck`   | Type-check all workspaces          |
| `pnpm format`      | Format repository files            |
| `pnpm clean`       | Clean build outputs                |
| `yantra template`  | Manage reusable report templates   |

## Report templates

Use a Markdown report template when an agentic result must follow your own
headings and sections. Create or import templates with `yantra template`, then
pass the same `--template <name|tag|path>` flag to `ask`, `research`, or `do`:

```bash
yantra template new weekly --tags work
yantra template lint weekly
yantra ask "summarize this week's status" --template weekly
yantra research "compare the vendors" --template tag:work --format html --open
yantra do "prepare a launch review" --template ./launch-review.md
```

The model fills typed slots while Yantra preserves the Markdown structure,
attaches fetched sources, validates the result, and writes `document.json`,
`document.md`, and inert `document.html`. Authors can add model-only document and
slot guidance that never appears in rendered reports. Templates require LLM mode, so
`--template` cannot be combined with `--no-llm` or `LLM_PROVIDER=none`.
`yantra run` does not support templates yet. See the complete
[report-template authoring guide](docs/report-templates.md).

## Ask (the Brief)

`yantra ask` answers a question from the web and hands back a **Brief** — a
single synthesized document, not a list of per-source cards:

```bash
yantra ask "cheapest Sony WH-1000XM5 today"
```

Pipeline stages are `search -> fetch -> extract -> synthesize -> render`. The
synthesizer reasons across sources into an answer-first overview, scannable key
findings, comparison tables, and numbered, verifiable citations. Synthesis is
**evidence-first**: it profiles the query, drops off-topic sources and headings
before assembly (surfacing each as an honest notice), cites each finding only
from the sources whose sentences actually support it, and renders citations as
small, muted superscripts rather than long `[1][4][6][7]` runs. Related
findings are grouped into parent/child bullets, and percentage comparison tables
include a Metric column so YoY declines, MoM rises, and market-share figures
stay readable instead of blending into context-free percentages.

```
Cheapest Sony WH-1000XM5 today
╭──────────────────────────────────────────────────────────────╮
│ Lowest price is $328 at Amazon (down from $399). All three    │
│ tracked retailers stock it; prices rose ~4% this week. [1][3]  │
╰──────────────────────────────────────────────────────────────╯

Key Findings
• Amazon — $328, in stock, free shipping [1]
• Best Buy — $349, in stock [2]

Comparison
┌──────────┬───────┬──────────┐
│ Retailer │ Price │ In stock │
├──────────┼───────┼──────────┤
│ Amazon   │ $328  │ ✓        │
└──────────┴───────┴──────────┘

Sources
[1] Sony WH-1000XM5 — Amazon — amazon.com
```

Every run also writes portable `brief.md` and a self-contained, inert
`brief.html` (open it with `--open`) alongside the canonical `brief.json`.

- **Progressive disclosure**: `--detail {overview|standard|full}` (terminal
  only; the `.md`/`.html`/`--json` artifacts are always full).
- **Output format**: `--format {terminal|md|html|json}` (`--json` is shorthand
  for `--format json` and stays a dependency-free, byte-stable envelope).
- **Length budget**: `--length {short|medium|long}`.
- **Agent-optional**: `--no-llm` (or `LLM_PROVIDER=none`) produces a real
  deterministic Brief.
- **Cache**: 24h cache in `~/.cache/yantra/ask` (disable with `--no-cache`).

Other flags: `--search-provider <auto|google|duckduckgo|brave|tavily>`,
`--max-sources`, `--limit`, `--fetch-timeout`, `--pipeline-timeout`, `--open`,
`--no-color`. Agent model and enforcement options are listed in the canonical
[Agentic options](docs/model-configuration.md#agentic-options) reference.

### Search providers

Search is a registry of first-class providers. `auto` (the default) walks an
ordered `search.fallback_chain`, skipping API providers whose key is missing, so
a keyless machine still answers via DuckDuckGo. Selecting a keyed provider
explicitly (flag/env/config) fails loud with an actionable hint when its key is
absent — no silent downgrade.

| Provider     | Key needed       | Notes                                                                                                                                 |
| ------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `tavily`     | `tavily.api_key` | Fast API path; first in the default chain.                                                                                            |
| `brave`      | `brave.api_key`  | API path; second in the default chain.                                                                                                |
| `duckduckgo` | none (scrapes)   | Key-free fallback; honors the ethics gate on every SERP fetch.                                                                        |
| `google`     | none (scrapes)   | Opt-in only (not in the default chain) — highest anti-bot friction; returns an honest "use a keyed provider" message when challenged. |

Precedence is `--search-provider` flag > `SEARCH_PROVIDER` env >
`config.search.provider` > `auto`. Configure the chain in `config.yaml`:

```yaml
search:
  provider: auto # auto | google | duckduckgo | brave | tavily
  fallback_chain:
    - tavily
    - brave
    - duckduckgo
  fetch_top: 3 # integer 1–5 (default 3)
```

`fetch_top` controls the combined `web_search` agent tool: how many of the top
hits it fetches and extracts inline (returning their page content), with the
remaining hits listed as snippet-only "more results". It is bounded to `1–5` so
one result cannot evict a small local model's context; an out-of-range or
non-integer value fails loud at startup (exit 1). It has no effect on the
deterministic `--no-llm` pipeline, which uses its own `--limit`.

API keys live in the OS keychain (`tavily.api_key`, `brave.api_key`), never in
`config.yaml`. Scraped providers never evade a bot wall or CAPTCHA — they report
the block and suggest a keyed provider.

Run artifacts are written under `~/.local/share/yantra/runs/<run-id>/`
(`manifest.json`, `events.jsonl`, `brief.json`, `brief.md`, `brief.html`,
fetched pages).

## Research (deep, multi-hop)

`yantra research` runs a **bounded multi-hop** loop where `ask` runs one — it
iterates `search -> fetch -> extract -> synthesize -> generate follow-up
queries -> diversify/dedup sources -> track coverage` and emits a **long-form,
sectioned Brief** that reads like an analyst's report:

```bash
yantra research "state of grid-scale battery storage in 2026" --depth 2
```

```
research: search-provider=auto depth=2 max-sources=24 no-llm=false detail=standard format=terminal model=anthropic/claude-haiku-4-5

State of grid-scale battery storage in 2026
╭──────────────────────────────────────────────────────────────╮
│ Deployments roughly doubled year over year, led by lithium-   │
│ iron-phosphate; costs fell ~18% while duration crept toward   │
│ 4-hour systems. Interconnection queues remain the bottleneck. │
│ [1][2][4]                                                     │
╰──────────────────────────────────────────────────────────────╯

Key Findings
• LFP chemistry now dominates new grid installs [1][3]
• Average installed cost fell to ~$xxx/kWh [2]
...

Sections
Key facts · Additional findings

Sources
[1] ...  [2] ...  [3] ...
```

Each hop maps the topic, then later hops target the **coverage gaps** the
synthesis surfaced. Everything is **budgeted** and the loop terminates cleanly —
never a hang, never a silent truncation — when any budget exhausts, emitting an
honest partial Brief with a `budget_exhausted` notice:

- **Hops**: `--depth {1|2|3}` (default `2`). `--depth 1` is `ask` with a bigger
  source budget.
- **Sources**: `--max-sources <n>` (default `24`); the pool dedups near-duplicate
  articles and caps sources per host so one domain can't dominate.
- **Wall-clock**: `--pipeline-timeout <duration>` (default `3m`).
- **LLM calls**: `--max-llm-calls <n>` (default `12`).
- **Agent-optional**: `--no-llm` (or `LLM_PROVIDER=none`) runs end to end —
  follow-up queries fall back to deterministic expansion and synthesis to the
  deterministic synthesizer.

Output flags mirror `ask`: `--detail {overview|standard|full}`,
`--format {terminal|md|html|json}` (`--json` shorthand), `--length`, `--open`,
`--search-provider`, `--fetch-timeout`, `--per-query-limit`, `--no-color`.
Agent options mirror every model-capable command — see
[Agentic options](docs/model-configuration.md#agentic-options).

Alongside the Brief artifacts, each hop writes a `research-state.json` snapshot
(queries, kept/fetched counts, coverage, remaining budget) to the run dir for
post-mortem inspection.

## Agentic web tasks (`yantra do`)

`yantra do "<goal>"` (alias `discover`) opens one fresh provider session and one
run-scoped, ephemeral browser. The provider owns the multi-turn reasoning loop;
Yantra supplies the policy-wrapped search, fetch, browser, script, and result
tools. Success requires a validated, persisted Brief—raw assistant prose is
progress, not completion.

```bash
yantra do "compare the current return policies for these two stores"
yantra do "submit the fixture form" --allow-host fixture.example
yantra do "log into xyz.com as @username{u1} with @password{p1}"
yantra do "research this topic" --provider anthropic --model claude-haiku-4-5
yantra do "..." --json                         # progress + outcome as NDJSON
```

Use `@{value}` or a tagged form such as `@password{value}` when a user-supplied
value must remain usable by tools but must never reach the model. Explicit
markers are the guarantee; keyword and shape detection are best-effort. A
malformed marker exits `1` before any run directory is created. See
[User-input masking](docs/user-input-masking.md) for the grammar, shell quoting,
echo-masking caveats, and persistence rules.

Live output streams assistant text and compact tool status lines without raw
tool payloads. Protected actions pause immediately before the side effect and
default to denial; waits are bounded, and `--json`/non-TTY runs fail closed
without prompting. CAPTCHA, bot walls, robots restrictions, and other controls
produce an honest handoff—Yantra never evades them.

**Two rules keep a `do` run grounded in what it actually saw.** Navigation is
restricted to URLs a tool result actually produced, plus the hosts and URLs you
supplied yourself (`--allow-host`, or a link in the goal) — so the agent cannot
assemble a "deep link" and publish from whatever page it happens to serve
(`URL_NOT_FROM_EVIDENCE`). And `browser_form_fill` lets
it drive a real multi-field search form — autocomplete destinations and calendar
date pickers included — in one call, so hand-building a URL is not the only way
through. It is available to `do` only, never submits, and never handles
credentials; use `browser_fill` for those. See
[docs/agent-tools.md](docs/agent-tools.md).

Hard budgets cover wall-clock time, per-tool timeout, provider tokens,
navigation/host count, and result bytes. Tool-call counts remain audit data, not
caps. At 80% of the wall clock, exploration winds down while publication remains
available, favoring an honest partial Brief over losing gathered evidence. See
the canonical [Agentic options](docs/model-configuration.md#agentic-options)
reference for every flag, configuration layer, and default. Exit codes are `0` for a
published Brief, `2` for failure or budget exhaustion, `4` for human handoff,
and `130` for an interrupt. `--save-as` is reserved for workflow promotion;
deterministic saved workflows continue to use `yantra run` without an LLM loop.

**A goal that needs your location, when Yantra does not have one, exits `4`
immediately** — before any tokens are spent or a browser launches:

```console
$ yantra do "cheap hotels near me"
This goal needs your location, but none is available and Yantra will not infer one.
Set one with `yantra prefs set locale.city "<city, state>"`, or name the location in the query.
```

If you turned location sharing off, the remedy names that instead. Yantra will
not substitute a city guessed from your timezone.

## Saved workflows (`yantra run`)

`yantra run <workflow>` replays a saved workflow deterministically — finite,
validated steps, no model in the loop:

```bash
yantra run bank-statement --params month=2026-04
yantra run bank-statement --params-file ./params.yaml
yantra run bank-statement --json
```

A successful run prints the outputs the workflow declared. If the workflow also
declares a `synthesis:` block, the run ends in a **Brief** instead — the same
`brief.json` / `brief.md` / `brief.html` trio `ask` and `do` produce, built from
the pages the run's `extract` steps actually read:

```yaml
synthesis:
  goal: What did the quarterly report say about revenue?
  length: medium # short | medium | long
  detail: standard # overview | standard | full
  use_llm: false # write the Brief with a model?
```

**The workflow decides how its Brief is written, not the command line.** There is
no mode flag to remember: `yantra run <name>` produces whatever the workflow was
saved to produce, every time. `use_llm: false` (the default) composes the document
deterministically and opens no provider session, so replay stays reproducible;
`use_llm: true` writes it through a model, and falls back to the deterministic
Brief on any failure. `yantra do "<goal>" --save-as <name>` sets both the goal and
`use_llm: true`, because a model wrote that run's report — so a promoted workflow
keeps producing the document that made the first run useful.

```bash
yantra run quarterly-report            # whatever the workflow declares
yantra run quarterly-report --no-llm   # force the deterministic Brief
```

A model may write the Brief; it never steers the replay. Step selection, branch
conditions, loop bounds, and locator resolution are fixed before execution and
cannot change based on model output. `--no-llm` (or `LLM_PROVIDER=none`) forces
the deterministic path, exactly as on `ask` and `research`; scheduled runs and
workflows invoked by an agent are always zero-LLM regardless of what the workflow
declares. See
[docs/workflow-extraction.md](docs/workflow-extraction.md#the-synthesis-block).

## Agentic options

`ask`, `research`, `do`, `run`, and `resume` share provider, model, credential,
budget, retry, confirmation, and deterministic-selection options. See the
canonical [Agentic options](docs/model-configuration.md#agentic-options)
reference for their meanings, preference keys, environment variables,
precedence, duration syntax, and defaults.

Report-template selection uses the same spelling on every agentic command:

| Flag               | Purpose                                             | Supported commands      |
| ------------------ | --------------------------------------------------- | ----------------------- |
| `--template <ref>` | Select a saved name, tag, or Markdown template path | `ask`, `research`, `do` |

```bash
yantra ask "what changed in the EU AI Act" --provider ollama --model llama3.1:8b
yantra research "grid-scale storage" --provider ollama --model llama3.1:8b
yantra do "research this topic" --provider anthropic --model claude-haiku-4-5
```

On `ask` and `research`, `--provider` selects the **LLM**; the unrelated
`--search-provider` selects the web-search backend. These flags have no effect
on `--no-llm` runs, which never construct a provider session — and on `yantra
run` they only choose _which_ model a workflow that asked for one gets, never
_whether_ it gets one, so a replay is never quietly opted into a model. See
[docs/model-configuration.md](docs/model-configuration.md) for credentials and
local-model setup.

## History & personalization

Yantra keeps a small **local SQLite index** (`~/.local/share/yantra/index.db`) of
every task it runs. It is a rebuildable cache — the run-dir files stay the source
of truth — so a deleted or corrupt index is a warning, never data loss (run
`yantra doctor` to rebuild it).

```bash
yantra list                 # recent tasks (ask/research/run), instantly, from the index
yantra list runs --limit 5  # newest first; falls back to a file scan if the index is gone
yantra usage                # task volume + cost rolled up by day and provider
yantra usage --type ask --since 7d   # filter by task type and age (7d, 24h, or YYYY-MM-DD)
```

Durable personal defaults live in a **human-editable** `~/.config/yantra/profile.yaml`
(search provider, detail/length, locale/city/region/units, favorite retailers,
interests) and are applied as flag defaults across `ask`/`research` (an explicit
flag always wins).

```bash
yantra profile                       # your effective preferences + where each came from
yantra prefs set defaults.detail full
yantra prefs get defaults.detail
yantra prefs --forget defaults.detail   # real deletion (privacy control)
```

**Your location is yours to grant.** The `context` block records which sensitive
facts the agent may be told about you. Today it holds one grant — `location` —
which gates the value composed from `locale.city` and `locale.region`:

```bash
yantra prefs set locale.city "Naperville, IL"   # the value
yantra prefs set context.location false         # withhold it from the agent
```

When the location is unavailable — denied, or simply never set — the agent is
told so explicitly and is **forbidden from deriving one**. A goal like
`"hotels near me"` then stops with a handoff naming the remedy, rather than
guessing a city from your timezone. The current date, timezone, and locale tag
are host-environment facts, not personal data; they are always supplied and are
not grants.

**Privacy:** only a short, **sanitized, user-approved** preference summary is ever
injected into a prompt (e.g. "Prefers metric units. Favors retailers: X, Y.").
**Raw run history and PII have no code path into an LLM payload** — a guarantee
enforced three ways (input typing, a 500-run property test, and an import-graph
guard). See [docs/personalization-and-privacy.md](docs/personalization-and-privacy.md).

## Local site ranking

Yantra collects a simple local quality signal for domains encountered during
deterministic and agentic web research: search hits add `+1`, while blocked,
failed, or unreadable pages add `-1`. Scores are bounded to `-100..100`; this
release collects and exposes them but does not use them to reorder results.

```bash
yantra sites list
yantra sites list --json
yantra sites add example.com
yantra sites remove example.com
```

`sites add` accepts hostname-shaped ASCII domains only (no schemes, paths,
ports, or credentials) and promotes an automatically observed row to user
curated. Ranking data is local-only in `index.db` and contains normalized
domains plus aggregate counts—never full URLs, queries, or page content. See
[docs/site-ranking.md](docs/site-ranking.md).

## Scheduling (unattended runs)

Register a saved workflow to run on a cron schedule, and a lightweight local
daemon fires it unattended — writing a Brief and notifying you on completion.

```bash
yantra schedule bank-statement --cron "0 8 * * 1"   # 08:00 every Monday
yantra schedules                                     # list schedules + next fires
yantra unschedule <id>

yantra daemon start          # start the scheduler (detached; --foreground to stay)
yantra daemon status         # running? pid? schedules? pending confirmations?
yantra daemon stop
```

**The one safety rule:** a scheduled run that reaches a `requires_confirmation`
step (a purchase, booking, or submit) **pauses and notifies — it never proceeds.**
`--on-confirm` accepts only `pause-and-notify`; there is no auto-confirm path.
Resolve a parked run with `yantra confirm <run-id> grant|deny`, and the daemon
resumes a granted run on its next poll. See [docs/scheduling.md](docs/scheduling.md).

## Packages

- `@yantra/protocol`: Zod schemas as the single source of truth for the agent/engine contract; TypeScript types, JSON Schema, and tool definitions are generated from these schemas.
- `@yantra/core`: Core runtime and execution engine surface.
- `@yantra/agent`: Agent-side integration surface. Hosts the thin `AgentProvider` seam backed by the [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) SDK — the SDK is imported only under `src/adapters/pi/` (boundary-tested).
- `@yantra/test-helpers`: Internal helpers for test-provider tags.
- `@yantra/cli`: CLI entrypoint package.
- `e2e/`: Cross-package integration and smoke tests.

The real browser tool suite requires system Chrome and runs without an LLM:

```bash
pnpm --filter @yantra/e2e exec vitest run agent-browser.spec.ts
```

It launches Chrome over CDP pipe with a fresh ephemeral profile and exercises
the local fixture site's navigate/observe/click/fill/extract, stale-ref,
actionability, secret-host-binding, and popup-interception paths. The remaining
agent prompt/consent/CAPTCHA/injection scenarios are covered with the agentic
orchestrator feature, where those policy layers are wired end to end.

Dependency direction (see `.spec-lite/plan_agentic.md` §3): `protocol -> core -> agent -> cli`. `@yantra/agent` composes `@yantra/core` services; `@yantra/core` must never import `@yantra/agent` (enforced by lint rule, boundary tests, and the CI static check).

### Agent API migration

The legacy internal `@yantra/agent` task-planning client has been removed. The supported internal surface is the provider seam, agent runtime, and typed agent errors; commands and user-owned workflow YAML or run artifacts are unchanged. Contributors must not restore the removed client, null-provider fallback, generated step-tool catalog, or manual discovery loop.

## Documentation

- Canonical project documentation lives under `docs/`.
- Protocol specification is generated at `docs/protocol-spec.md`.
- Agent model configuration & credentials: [docs/model-configuration.md](docs/model-configuration.md).
- Run directory layout & the provider session artifact: [docs/run-artifacts.md](docs/run-artifacts.md).
- Diagnostics & agent startup error codes: [docs/diagnostics.md](docs/diagnostics.md).
- Agent tool runtime, budgets & tool safety: [docs/agent-tools.md](docs/agent-tools.md).
- Guaranteed user-input masking: [docs/user-input-masking.md](docs/user-input-masking.md).
- The `extract` step, extraction schemas & the shared read pipeline: [docs/workflow-extraction.md](docs/workflow-extraction.md).
- Agentic runtime release notes: [docs/agentic-release-notes.md](docs/agentic-release-notes.md).
- Release-gate coverage and evidence: [docs/release-gate.md](docs/release-gate.md).
- Personalization & privacy: [docs/personalization-and-privacy.md](docs/personalization-and-privacy.md).
- Local site ranking: [docs/site-ranking.md](docs/site-ranking.md).
- Scheduling & the local daemon: [docs/scheduling.md](docs/scheduling.md).

## Continuous Integration

CI runs a 7-cell matrix:

- `LLM_PROVIDER=anthropic` on Ubuntu, macOS, and Windows
- `LLM_PROVIDER=none` on Ubuntu, macOS, and Windows
- `LLM_PROVIDER=ollama` on Ubuntu only

See [.github/workflows/ci.yml](.github/workflows/ci.yml) for details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
