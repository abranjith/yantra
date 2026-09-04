# Yantra

Yantra is a local-first command-line platform for public-web research, governed browser automation, and deterministic saved workflows. It combines model-assisted work with application-enforced boundaries for consent, secrets, outbound access, budgets, validation, and local audit records.

Yantra is intentionally focused on browser and web tasks. It is not a general desktop, shell, filesystem, or code-execution agent.

## Current status

This repository is a private, unpublished `0.0.0` pnpm workspace. There is no verified npm, Homebrew, Scoop, or standalone-binary distribution, and the source checkout does not link a global `yantra` executable. Run the built CLI through `node apps/cli/dist/bin.js`.

## Repository workspaces

- `@yantra/protocol` defines the shared Zod contracts and generates TypeScript types, JSON Schema, and the protocol reference.
- `@yantra/core` provides the provider-independent browser, workflow, research, policy, persistence, scheduling, and diagnostics engines.
- `@yantra/agent` composes core services for governed model-driven execution and confines provider-SDK integration to its adapter seam.
- `@yantra/test-helpers` supplies shared fixtures and no-LLM/provider test-tag plumbing.
- `@yantra/cli` is the executable composition root for commands, configuration, output rendering, and exit-code mapping.

## Install and start from source

Prerequisites are Node.js 24.15.0 or newer and pnpm 11.1.0. System Chrome 120 or newer is required for browser tasks and saved-workflow replay.

```console
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/bin.js --help
node apps/cli/dist/bin.js init --provider none --yes
```

The smallest useful no-model task uses keyless DuckDuckGo search and local synthesis. It contacts public sites and writes a local run directory:

```console
node apps/cli/dist/bin.js ask "what is Yantra's current public release status?" --no-llm --search-provider duckduckgo
```

See the [Quickstart](docs/quickstart.md) for prerequisites and platform paths, then the [Usage guide](docs/usage.md) for model credentials, local models, commands, artifacts, and configuration.

## What you can do

- Answer focused web questions with `ask`, or investigate broader topics with bounded multi-hop `research`. Both support deterministic `--no-llm` execution.
- Run governed model-driven browser tasks with `do`, including navigation, extraction, form filling, and separately confirmed protected actions.
- Promote successful browser traces or author reviewable YAML workflows, then replay them with a fixed plan that a model cannot steer.
- Schedule saved workflows through a local daemon. Scheduled runs are always zero-LLM and pause rather than auto-confirm protected actions.
- Shape model-backed output with local report templates, and inspect local profiles, history, usage, run reports, and audit trails.

## Safety and current boundaries

Yantra honors robots policy, blocklists, rate limits, CAPTCHAs, and bot walls; it reports a refusal or handoff instead of evading controls. Agentic browser profiles are fresh and ephemeral, while model-backed `do` tasks require configured credentials. Explicit input masking and keychain-backed secrets reduce exposure, but run directories and provider-session artifacts can still contain sensitive material and should be reviewed before sharing. Sources and citations establish provenance, not correctness or freshness.

## Documentation

### Guides

- [Architecture](docs/architecture.md) — components, data flows, persistence, and design decisions.
- [Quickstart](docs/quickstart.md) — source installation and the first deterministic task.
- [Usage](docs/usage.md) — complete CLI, configuration, artifacts, and exit-code guide.

### Features

- [Ask](docs/features/ask.md) — focused public-web questions and synthesized Briefs.
- [Research](docs/features/research.md) — agentic and deterministic multi-hop research.
- [Agentic Tasks](docs/features/agentic-tasks.md) — governed browser and web tasks with `do`.
- [Saved Workflows](docs/features/saved-workflows.md) — workflow YAML, replay, promotion, and resume.
- [Report Templates](docs/features/report-templates.md) — typed, user-authored report structures.
- [Profiles and History](docs/features/profiles-and-history.md) — preferences, context grants, runs, and usage.
- [Local Site Ranking](docs/features/site-ranking.md) — local domain outcome scores and curation.
- [Scheduling](docs/features/scheduling.md) — recurring workflow runs and the local daemon.
- [Diagnostics and Audit](docs/features/diagnostics-and-audit.md) — environment checks and run inspection.
- [Opt-In Vision Assist](docs/features/vision-assist.md) — consent-gated, budgeted, audited screenshots for agentic browser fallback.
- [Recovery as Declarative Data](docs/features/recovery-as-declarative-data.md) — bounded fill and click recovery plans, shared accounting, and verdict diagnostics.
- [Widget Gauntlet and Interaction Message Catalog](docs/features/widget-gauntlet-harness.md) — generic widget regression fixtures, operation accounting, real-browser tool testing, and catalog contracts.
- [Safety and Privacy](docs/features/safety-and-privacy.md) — masking, consent, secrets, policy, and audit boundaries.

### Generated reference

- [Protocol specification](docs/protocol-spec.md) — generated Zod contracts, fields, and examples.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pnpm workflow, architectural boundaries, testing conventions, and pre-commit checks.

## License

Yantra is licensed under the [Apache License 2.0](LICENSE). Third-party attribution notices are in [NOTICE](NOTICE).
