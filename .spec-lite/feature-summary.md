# Feature Summary

Current-state reference for all implemented features. Updated by the Implement skill after each feature completes.

---

## Plan Executor

### Plan Executor & Step Verbs (FEAT-005)

The `Executor` class drives a `Plan.steps` array to completion, maintaining an `ExecutionContext` that carries all mutable state for one run: captures, retry budgets, an event bus, a checkpoint store, and an ethics gate. Each step is dispatched through a `STEP_DISPATCH` map (navigate, click, fill, extract, wait_for, assert, branch, loop, call_workflow, llm_summarize). Step results are a discriminated union — `completed`, `retried`, `failed`, `handoff_requested`, `ethics_refused`, or `jump` (for branch goto semantics). The executor enforces a `MAX_TOTAL_STEP_EXECUTIONS` guard to prevent infinite loops.

**Retry budgets** are three independent token counters (`locatorAttempts`, `stepAttempts`, `workflowAttempts`). `consume()` throws `BudgetExhaustedError` past zero. `snapshot()/clone()` support checkpoint-based resume. **Captures** (`InMemoryCaptureStore`) accumulate `extract` step output under `step_id` keys; values >64 KB are represented as sidecar references in snapshots. **Scope enforcement** (`checkScopeViolations`) preflights the entire plan before execution using `ALLOWED_VERBS_BY_SCOPE` from protocol; scope violations abort before step 1 runs.

**Checkpointing** (`FilesystemCheckpointStore`) writes atomically via `.tmp` + `fs.rename` after each successful step. Resume (`resumeFrom`) restores capture state from the snapshot and re-enters the step loop from the checkpoint's `after_step_idx + 1`. **Events** (`JsonlEventBus`) buffer in memory and flush to `events.jsonl` every 200 ms (debounced), with a synchronous `flush()` forced before checkpoint writes. **Reports** (`writeReport`) produce a Markdown call-log at `report.md`.

**Ethics gate** (`EthicsGateImpl`) enforces blocklist first (synchronous) and rate-limiter last (in-process per-host token bucket, injectable `Clock` for tests). Robots.txt enforcement is now opt-in via config (`ethics.robots_enabled: true`); when enabled it runs between blocklist and rate-limiter with 24h per-host caching (fail-open for 404 per RFC 9309, fail-closed for timeouts/5xx). `handleNavigate` calls the gate before any `page.goto`. **Value resolution** (`ValueResolver`) handles `literal`, `param`, `capture`, and `template` refs; secrets use a separate `resolveSecret()` path that returns a `{plaintext, zero}` pair — secrets are never returned by `resolve()` and never appear in step_completed event payloads.

The `FileUsageWriter` batches `UsageCall` records and persists them as a `UsageLedger` at `usage.json`. Stub handlers for `call_workflow` (FEAT-010) and `llm_summarize` (FEAT-011) return structured failures pointing to those features.

## Browser Engine

### Locator Engine & Auto-Wait (FEAT-004)

The locator engine resolves named UI targets via ordered **candidate chains** (each candidate is a typed `LocatorIntent`). `LocatorResolverImpl.resolve(chain)` walks candidates in order, calling the browser-side InjectedScript via `InjectedScriptHost.call()`. Strict mode (default) treats >1 match as an immediate ambiguity failure; per-candidate timeouts fall through to the next candidate rather than aborting. A `LocatorResolutionEvent` is emitted via the optional `LocatorEventSink` after every resolve call carrying chain name, outcome, winning index, and duration (no DOM content — security invariant enforced by property test).

`resolveActionable(chain, host, options)` wraps the resolver in a Playwright-style auto-wait loop: backoff `[0, 20, 50, 100, 100, 500, 500, …]` ms, comparing two `getBoundingRect` snapshots 100 ms apart for stability. Non-retriable failures (`ambiguous`, `frame_detached`) throw immediately; `not_actionable` at deadline throws `LocatorNotActionableError` carrying the last `ActionableState`.

The **InjectedScript bundle** (`dist/injected.bundle.js`, IIFE, < 50 KB, no `require()`, no `process.env`) is built by esbuild from `src/locator/injected/index.ts` and registers `window.__yantra`. Eight resolution strategies are implemented in the injected layer: `role+name` (WAI-ARIA computed role + accessible-name algorithm, ported from Playwright Apache-2.0), `testid` (configurable attribute aliases), `label` (`<label for>`, implicit wrap, aria-labelledby, aria-label), `placeholder`, `text` (normalized + regex), `css` (with a unique-CSS generator using stable-class heuristics), `xpath`, and `relative` (all 7 RelativeRelation variants). `CSS.escape` and `elementFromPoint` are used browser-side.

The **candidate ranking algorithm** (`ranking.ts`, browser-side) scores candidates by base weight (testid=1.00, role=0.90, label=0.75, placeholder=0.60, css=0.45, relative=0.30, xpath=0.10) × specificity × stability, sorts descending, and caps to `topN` (default 5). Ties break by kind order for determinism. Used at record time by FEAT-008.

The `intent-codec.ts` module provides `encodeIntent`/`decodeIntent` for the JSON ↔ `LocatorIntent` round-trip (RegExp serialized as `{ __isRegExp, pattern, flags }`). Errors (`LocatorNotFoundError`, `LocatorAmbiguousError`, `HitTargetInterceptedError`, `LocatorNotActionableError`, `FrameDetachedError`, `LocatorInvalidSelectorError`) all carry structured context for failure reports.

### Chrome Launcher & BrowserProvider (FEAT-003)

`LocalBrowserProvider.launch()` spawns system Chrome over CDP pipe transport (`--remote-debugging-pipe`, no WebSocket port), returning a `LocalBrowserSession`. It validates `LaunchOptions` via Zod, resolves the profile via `LocalProfileStore`, discovers Chrome with `detectChrome()`, and rejects unsupported versions (< 120). Crash events are detected via child-process `exit`, emitted as `BrowserCrashedError`, and ephemeral profiles are cleaned up best-effort. The session's `newPage()` rejects if the session is closed or crashed.

`detectChrome()` discovers Chrome per-platform without ever opening a browser window. On macOS/Linux it reads the version by running `<chrome> --version`. On Windows it deliberately does **not** execute `chrome.exe` (which on Windows prints nothing and instead opens a visible browser window); instead it locates the binary via the App Paths registry key or standard install paths and reads the version from the versioned `Application\<version>` subfolder, falling back to PowerShell `VersionInfo.ProductVersion`. The `reg query` probe discards child stderr so a missing registry key does not leak an error to the console. _(updated: 2026-05-19 by fix)_

`LocalProfileStore` manages per-workflow profile dirs (`~/.local/share/yantra/profiles/<name>` with chmod 0700 on Unix), ephemeral dirs (`<tmpdir>/yantra-<uuid>`), and explicit absolute paths. It enforces a refused-path guard that rejects the user's real Chrome profile roots (macOS Library, Linux .config, Windows AppData).

`yantra doctor` runs six checks (chrome.detected, chrome.version_min, datadir.writable, datadir.permissions, cachedir.writable, keychain.reachable), never throws, caches results for 1 hour at `~/.cache/yantra/doctor.json` (mode 0600), and returns a `DoctorReport` with an `overall` rollup of ok/warn/error. Permission checks walk per-workflow profile subdirs and report offenders in `details.offenders`.

Path helpers in `paths.ts` honor `XDG_DATA_HOME`/`XDG_CACHE_HOME` on Linux and `%LOCALAPPDATA%` on Windows.

## Ask Pipeline

### Ask Pipeline (FEAT-007)

FEAT-007 is implemented across `packages/core/src/extraction` and `apps/cli/src/commands/ask.ts`. The pipeline now supports the full `search -> fetch -> extract -> summarize -> render` flow with deterministic, no-LLM-first behavior. The core orchestration is implemented by `AskPipeline` in `ask-pipeline.ts`, with per-source failure isolation (notice cards), cache short-circuiting, run-artifact persistence, and protocol event emission.

Search is strategy-based through `selectSearchProvider()` and concrete providers in `search/tavily.ts`, `search/brave.ts`, and `search/browser.ts`. The default selector now treats `auto` as **API-first**: Tavily (if `tavily.api_key` exists) → Brave (if `brave.api_key` exists) → browser fallback. Explicit `tavily`/`brave` requests still require matching keys and fall back to browser when missing. Browser search continues to pass through the ethics gate, so robots refusals are surfaced as first-class errors. The browser provider scrapes DuckDuckGo's HTML endpoint and launches Chrome with a realistic desktop User-Agent (matching the detected Chrome major version, never `HeadlessChrome`) and `--disable-blink-features=AutomationControlled` to reduce anti-bot challenges; when DuckDuckGo still serves its anomaly/CAPTCHA page, the provider raises a clear `anomaly-challenge` error advising a keyed provider rather than the generic "no result rows". _(updated: 2026-05-19 by fix)_

Fetching and extraction are handled by `HybridContentFetcher` (`fetcher.ts`) and `ReadabilityExtractor` (`readability.ts`) with resilient malformed-document handling. Summarization defaults to `RuleBasedSummarizer` (`summarizer.ts`) and the LLM seam is in place via `createLlmSummarizer()` (`llm-summarizer.ts`), which intentionally returns `null` under FEAT-007 gates so the feature remains fully usable with `LLM_PROVIDER=none`.

Output rendering is implemented in `card.ts` for terminal, JSON, and markdown report paths. Cache storage is implemented in `cache.ts` and `cache-key.ts` with UTC-day scoping, TTL enforcement, and size-cap eviction.

CLI integration is implemented in `apps/cli/src/commands/ask.ts` and wired through `apps/cli/src/index.ts`/`apps/cli/src/bin.ts`. The command supports `--json`, `--no-llm`, `--no-cache`, `--search-provider`, `--limit`, `--fetch-timeout`, `--budget-ms`, and `--budget`.

Verification coverage includes extraction unit suites under `packages/core/tests/extraction`, CLI ask command tests under `apps/cli/src/commands/ask.spec.ts`, and ask-focused E2E tests in `e2e/ask.spec.ts` and `e2e/ask-no-llm.spec.ts`.

## Workflow Authoring

**Annotate UI & Workflow YAML** _(updated: 2026-05-16 by implement)_
Source spec: [feature_annotate_and_yaml.md](.spec-lite/features/feature_annotate_and_yaml.md)
Closes the record→review→save loop that converts a raw recording draft into a production-ready Workflow YAML file. The `AnnotateSession` state machine walks each captured action interactively (keep/skip, locator name, param/secret/output promotion, scope override) and produces a fully validated `WorkflowFile`. The `FileWorkflowStore` persists workflows atomically to `~/.local/share/yantra/workflows/<name>.yaml`, with sidecar `.locators.json` emission when `_locators` exceeds 50 entries. `yantra lint <file.yaml>` validates offline using 12 pluggable lint rules (mandatory errors: `SecretShapedLiteralInValue`, `UndeclaredSecretRef`, `UndeclaredParamRef`, `JSONataExpressionInvalid`, `ScopeMutatingVerbInReadOnlyData`, `MixedExpressionForms`). A sandboxed `JSONataEvaluator` wraps the `jsonata` package with a 200 ms timeout, 100 KB result cap, no custom functions, and no global access.

## Recorder

### Recorder Phase 1 (FEAT-008)

FEAT-008 is implemented across `packages/protocol/src/schemas/recording-draft.ts` and `packages/core/src/workflow/recorder/`. A `RecordingSession` orchestrates a visible Chrome browser session (via puppeteer-core), injects a CDP overlay script into every page, and produces a `draft.json` artifact containing all captured user actions.

The **protocol schema** (`RecordingDraftSchema`, `CapturedActionSchema`) lives in `@yantra/protocol` and enforces the redaction guarantee at the type level: `fill.raw_value` is `z.literal('<redacted>')`, so any attempt to persist an unredacted fill value is a compile-time error. The pre-redaction types (`RawCapturedActionInput`, `RawFillAction`) are internal to the `redactor.ts` module and not re-exported from the recorder barrel.

The **overlay** (esbuild IIFE bundle, built with `pnpm --filter @yantra/core build:recorder-overlay`) runs in-page and captures `click`, `input` (250 ms debounce), `change`, and `keydown(Enter)` events. For each captured action it calls `buildElementDescriptor()` (ARIA role + accessible name + sanitized attr sample + XPath debug string) and forwards the payload to Node via a CDP `Runtime.addBinding` channel. The overlay also draws a fixed-position recording indicator (red dot + action counter) and advises the user to "stop with Ctrl+C in the terminal".

The **redactor** (`DefaultCaptureRedactor`) is the only code that reads `raw_value`; it replaces it with the sentinel `'<redacted>'` and records `value_length` (code-point count). Defense-in-depth `defangAttrValue()` strips credential-shaped strings (sk-, sk-proj-, ghp*, AKIA, eyJ, xoxb-, gho*, glpat-) from element attribute samples before they are persisted.

**Session lifecycle**: `RecordingSession.start(name)` generates a time-ordered recording ID, calls `RecordingStore.create()`, launches Chrome headful, registers the CDP binding and overlay, sets up popup attachment (`PopupHandler`), cross-origin iframe detection, and starts the `IdleWatcher` (default 5-minute timeout, fires `IdleTimeoutPromptEvent`). `RecordingSession.stop(reason)` assembles and Zod-validates the draft via `assembleDraft()`, writes it atomically to `draft.json`, removes the partial draft, closes the browser, and destroys the ephemeral profile unless `keepProfile` was set. `abort()` preserves the profile for post-mortem.

**Crash safety**: `appendAction` + `FileSystemRecordingStore` write `draft.partial.json` atomically (`.tmp` + `fs.rename`) after every captured action. If the process crashes before `stop()`, the partial draft survives on disk.

**Tests** (all tagged `@no-llm`): 66 unit tests across `redactor.spec.ts` (incl. 500-run fast-check property test), `descriptor-builder.spec.ts` (jsdom, 22 tests), `draft-builder.spec.ts` (10 tests), `store.spec.ts` (8 tests), `idle-watcher.spec.ts` (7 fake-timer tests), `session.spec.ts` (4 integration + state-machine tests).

## Agent Integration

### Agent Integration — pi-agent-core Adapter (FEAT-011)

`packages/agent` provides the `LLMClient` strategy interface wrapping `pi-agent-core` behind a stable internal boundary. The package cannot import `@yantra/core` (architectural boundary enforced at the compiler level). The `createLLMClient(config)` factory resolves the provider from `LLM_PROVIDER` env → config → degrades gracefully to `NullLLMClient` (returns `LLMUnavailable` immediately, zero I/O) when `LLM_PROVIDER=none` or `pi-agent-core` is unavailable.

`runGeneratePlan()` implements the full generation loop: sanitizer guard → system-prompt assembly (tools sorted by name for canonical SHA-256 hash) → provider call → Zod schema validation → semantic validation (FEAT-002's `validateSemantics`) → bounded re-prompt (max `budget.maxCalls` retries, errors serialized as JSON-pointer paths). On repeated failure `dominantErrorCode()` picks the most-frequent validation error code and `resolveUserFacingHint()` maps it to an actionable message. `wrapWithAudit()` wraps any `LLMClient` to emit two `AgentJsonlEntry` records per call (request + response) with fields including `run_id`, `provider_id`, `system_prompt_hash`, `tool_calls`, token counts, `cost_estimate_usd`, `attempt`, and `outcome`. `estimateCostUsd()` covers Claude 4 and 3.5 model families. `Sanitized<T>` brand type plus LRU-registry `assertSanitized()` enforce runtime sanitization at the LLM call boundary. `InMemoryAuditWriter` and `InMemoryUsageWriter` are provided for testing without I/O.

## CLI Surface

**CLI Polish, Audit, Distribution** _(updated: 2026-05-16 by implement)_
Source spec: [feature_cli_polish_distribution.md](.spec-lite/features/feature_cli_polish_distribution.md)
Caps the MVP with the user-visible command surface: `yantra ask`, `run`, `resume`, `list`, `show`, `lint`, `audit`, `report`, `doctor`, `init` — all behind a single `yantra` binary with a documented exit-code map (0 OK / 1 validation / 2 execution / 3 environment / 4 user-handoff). The `--json` flag emits a stable `schemaVersion: "0.1"` envelope on every command for scripting. `yantra audit <run-id>` builds a structured audit report (trust narrative + agent/secret/engine sections) from `manifest.json` + `agent.jsonl` + `secrets.jsonl` + `events.jsonl` without ever surfacing secret values. `yantra report <run-id>` prints (or `--open`s) the per-run `report.md` verbatim. `yantra doctor` extends FEAT-003 v0 with overall ok/warn/fail rollups and remediation hints.

The `ConnectorIO` interface in `apps/cli/src/connector-io.ts` is the load-bearing abstraction that decouples the CLI surface from the underlying executor — Phase 2 connectors (WhatsApp, email, web) plug in by implementing this single interface. `TerminalRenderer` and `JSONRenderer` are interchangeable implementations of `OutputRenderer`; `buildRenderOpts(flags)` picks between them at process start based on `--json` / TTY detection / `NO_COLOR`. The runtime helper (`apps/cli/src/runtime.ts`) wires the workflow orchestrator dependency graph (ethics gate, browser provider, keychain, profile store, workflow store, run store) so individual subcommands don't repeat the boilerplate.

Verification: 29 unit tests across `apps/cli/src/` (commander setup, exit-code map, global-flags parser, ConnectorIO contract, audit-builder round-trip, auto-detect for `show`); 7 e2e tests in `e2e/cli-commands.spec.ts` covering the no-args banner, `list runs|workflows --json` empty roots, `audit`/`report` not-found paths, and `init --provider {none|invalid}`. Distribution channels (npm `bin: { yantra: dist/bin.js }`, Homebrew tap, Scoop bucket) and the bundled-CLI release pipeline are deferred to the first stable release.

## Security Envelope

### Security Envelope (FEAT-006)

FEAT-006 is implemented across `packages/core/src/sanitizer`, `packages/core/src/secrets`, `packages/core/src/audit`, and `scripts/ci-static-check.ts`. The sanitizer now has a single chokepoint `sanitize(payload, profile, hostHint?)` with deterministic transform ordering, profile matrix (`public`, `read-only-data`, `authenticated`), host override support, transformation tagging, and UTF-8-safe truncation. The `llm_summarize` handler in the executor sends `sanitized.text`, ensuring LLM-bound content flows through the sanitizer path.

Secret handling is now centralized through the opaque resolver/keychain boundary. `DefaultOpaqueRefResolver` resolves `ValueRef` variants and emits secret-resolution metadata (never secret values), `createKeychainProvider()` returns either a keytar-backed provider or a degraded unavailable provider with one-shot warning logging, and `withSecret` provides best-effort in-memory zeroing semantics for transient secret usage.

Contextual scope enforcement is now a shared core primitive: `packages/core/src/secrets/scope-enforcer.ts` validates plans and rejects mutating behavior in `read-only-data` scope, while the executor wrapper delegates to it and maps violations into executor-level errors.

Audit output is now complete for the FEAT-006 surface. `JsonlAuditLogWriter` appends `agent.jsonl` and `secrets.jsonl` entries, writes scope-summary data into run manifests, and `FilesystemReportBuilder` renders a readable `report.md` from run artifacts. The CI guard `security:static-check` is wired to `scripts/ci-static-check.ts`, which enforces sanitize-before-send and package-boundary restrictions for `pi-agent-core` imports.

Verification coverage includes targeted FEAT-006 suites (12 files / 48 tests) covering sanitizer transforms/profiles/truncation/host overrides, keychain and resolver behavior, scope enforcement, secret zeroing, audit writer/report builder, and static-check fixtures. Property-based tests are in place for sanitizer invariants, query/token stripping, UTF-8 truncation safety, scope validation, and JSONL parseability.
