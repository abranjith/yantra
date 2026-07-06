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

## Ask (the Brief)

`yantra ask` answers a question from the web and hands back a **Brief** — a
single synthesized document, not a list of per-source cards:

```bash
yantra ask "cheapest Sony WH-1000XM5 today"
```

Pipeline stages are `search -> fetch -> extract -> synthesize -> render`. The
synthesizer reasons across sources into an answer-first overview, scannable key
findings, comparison tables, and numbered, verifiable citations.

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
`--limit`, `--fetch-timeout`, `--budget-ms`, `--budget`, `--open`, `--no-color`.

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
```

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
research: provider=auto depth=2 max-sources=24 no-llm=false detail=standard format=terminal

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
Numbers & figures · Key facts · People & organizations

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
- **Wall-clock**: `--budget-ms <ms>` (default `180000`).
- **LLM calls**: `--budget <n>` (default `12`).
- **Agent-optional**: `--no-llm` (or `LLM_PROVIDER=none`) runs end to end —
  follow-up queries fall back to deterministic expansion and synthesis to the
  deterministic synthesizer.

Output flags mirror `ask`: `--detail {overview|standard|full}`,
`--format {terminal|md|html|json}` (`--json` shorthand), `--length`, `--open`,
`--search-provider`, `--fetch-timeout`, `--per-query-limit`, `--no-color`.

Alongside the Brief artifacts, each hop writes a `research-state.json` snapshot
(queries, kept/fetched counts, coverage, remaining budget) to the run dir for
post-mortem inspection.

## Discovery mode (`yantra do`)

`yantra do "<goal>"` (alias `discover`) works the **live web in real time**
toward a goal with no saved workflow: propose a small next step, execute it
through the deterministic engine, observe the (sanitized) result, re-plan —
repeating under hard budgets until the goal is met, blocked, or exhausted.

```bash
yantra do "find the cheapest flight from SFO to JFK next Friday"
yantra do "check ticket availability" --dry-run       # validate proposals, never execute
yantra do "..." --allow-host example.com              # seed the host allowlist
yantra do "..." --save-as my-workflow                 # promote a successful path
```

Every mutating action (navigate/click/fill) always pauses for your explicit
consent — a card like this renders in the terminal and blocks until you answer:

```
┌─ Confirmation required ─────────────────────────────
│ Action:      navigate on ticketsite.example
│ Description: Navigate to ticketsite.example/events
│ Cost:        unknown
│ Consequence: reversible
└──────────────────────────────────────────────────────
Allow this action? (y/N)
```

Nothing is ever auto-granted — `--yes-to nothing` is the only accepted value
for that flag, and it documents exactly that. The model never sees raw HTML or
your DOM: it only ever receives a sanitized page digest plus a capped, ranked
list of interactable elements (role/name/kind/disabled — no values, no
attributes). It has no access to secrets or stored credentials, and it must
report a bot-detection wall or CAPTCHA honestly rather than try to evade it.

Budgets bound every session: `--max-steps` (default 15), `--budget` (max LLM
propose calls, default 20), `--budget-ms` (wall-clock, default 5 minutes).
Exit codes: `0` goal met or a clean budget-exhausted stop, `2` unreachable or
aborted (e.g. the proposer's re-prompt budget ran out), `4` a confirmation was
declined. A successful path can be promoted into a saved, replayable workflow
with `--save-as <name>`.

> **Current limitation**: no code path anywhere in the repo yet wires a real
> element-locator host to a live browser page (a pre-existing gap that also
> affects `yantra run`), so today `do` can meaningfully `navigate` and observe
> a page, but `click`/`fill`/`extract` against a real site are not yet wired
> end-to-end. See `.spec-lite/TODO.md`.

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
(search provider, detail/length, locale/units, favorite retailers, interests) and
are applied as flag defaults across `ask`/`research` (an explicit flag always
wins).

```bash
yantra profile                       # your effective preferences + where each came from
yantra prefs set defaults.detail full
yantra prefs get defaults.detail
yantra prefs --forget defaults.detail   # real deletion (privacy control)
```

**Privacy:** only a short, **sanitized, user-approved** preference summary is ever
injected into a prompt (e.g. "Prefers metric units. Favors retailers: X, Y.").
**Raw run history and PII have no code path into an LLM payload** — a guarantee
enforced three ways (input typing, a 500-run property test, and an import-graph
guard). See [docs/personalization-and-privacy.md](docs/personalization-and-privacy.md).

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
- `@yantra/agent`: Agent-side integration surface.
- `@yantra/test-helpers`: Internal helpers for test-provider tags.
- `@yantra/cli`: CLI entrypoint package.
- `e2e/`: Cross-package integration and smoke tests.

## Documentation

- Canonical project documentation lives under `docs/`.
- Protocol specification is generated at `docs/protocol-spec.md`.
- Personalization & privacy: [docs/personalization-and-privacy.md](docs/personalization-and-privacy.md).
- Scheduling & the local daemon: [docs/scheduling.md](docs/scheduling.md).

## Continuous Integration

CI runs a 7-cell matrix:

- `LLM_PROVIDER=anthropic` on Ubuntu, macOS, and Windows
- `LLM_PROVIDER=none` on Ubuntu, macOS, and Windows
- `LLM_PROVIDER=ollama` on Ubuntu only

See [.github/workflows/ci.yml](.github/workflows/ci.yml) for details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
