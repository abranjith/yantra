# Feature Summary

Current-state reference for all implemented features. Updated by the Implement skill after each feature completes.

---

## Plan Executor

### Plan Executor & Step Verbs (FEAT-005)

The `Executor` class drives a `Plan.steps` array to completion, maintaining an `ExecutionContext` that carries all mutable state for one run: captures, retry budgets, an event bus, a checkpoint store, and an ethics gate. Each step is dispatched through a `STEP_DISPATCH` map (navigate, click, fill, extract, wait_for, assert, branch, loop, call_workflow, llm_summarize). Step results are a discriminated union — `completed`, `retried`, `failed`, `handoff_requested`, `ethics_refused`, or `jump` (for branch goto semantics). The executor enforces a `MAX_TOTAL_STEP_EXECUTIONS` guard to prevent infinite loops.

**Retry budgets** are three independent token counters (`locatorAttempts`, `stepAttempts`, `workflowAttempts`). `consume()` throws `BudgetExhaustedError` past zero. `snapshot()/clone()` support checkpoint-based resume. **Captures** (`InMemoryCaptureStore`) accumulate `extract` step output under `step_id` keys; values >64 KB are represented as sidecar references in snapshots. **Scope enforcement** (`checkScopeViolations`) preflights the entire plan before execution using `ALLOWED_VERBS_BY_SCOPE` from protocol; scope violations abort before step 1 runs.

**Checkpointing** (`FilesystemCheckpointStore`) writes atomically via `.tmp` + `fs.rename` after each successful step. Resume (`resumeFrom`) restores capture state from the snapshot and re-enters the step loop from the checkpoint's `after_step_idx + 1`. **Events** (`JsonlEventBus`) buffer in memory and flush to `events.jsonl` every 200 ms (debounced), with a synchronous `flush()` forced before checkpoint writes. **Reports** (`writeReport`) produce a Markdown call-log at `report.md`.

**Ethics gate** (`EthicsGateImpl`) is NON-BYPASSABLE: blocklist check first (synchronous), robots.txt second (24h per-host LRU cache, fail-open for 404 per RFC 9309, fail-closed for timeouts/5xx), rate-limiter last (in-process per-host token bucket, injectable `Clock` for tests). `handleNavigate` calls the gate before any `page.goto`. **Value resolution** (`ValueResolver`) handles `literal`, `param`, `capture`, and `template` refs; secrets use a separate `resolveSecret()` path that returns a `{plaintext, zero}` pair — secrets are never returned by `resolve()` and never appear in step_completed event payloads.

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

`LocalProfileStore` manages per-workflow profile dirs (`~/.local/share/yantra/profiles/<name>` with chmod 0700 on Unix), ephemeral dirs (`<tmpdir>/yantra-<uuid>`), and explicit absolute paths. It enforces a refused-path guard that rejects the user's real Chrome profile roots (macOS Library, Linux .config, Windows AppData).

`yantra doctor` runs six checks (chrome.detected, chrome.version_min, datadir.writable, datadir.permissions, cachedir.writable, keychain.reachable), never throws, caches results for 1 hour at `~/.cache/yantra/doctor.json` (mode 0600), and returns a `DoctorReport` with an `overall` rollup of ok/warn/error. Permission checks walk per-workflow profile subdirs and report offenders in `details.offenders`.

Path helpers in `paths.ts` honor `XDG_DATA_HOME`/`XDG_CACHE_HOME` on Linux and `%LOCALAPPDATA%` on Windows.

## Ask Pipeline

### Ask Pipeline (FEAT-007)

FEAT-007 is implemented across `packages/core/src/extraction` and `apps/cli/src/commands/ask.ts`. The pipeline now supports the full `search -> fetch -> extract -> summarize -> render` flow with deterministic, no-LLM-first behavior. The core orchestration is implemented by `AskPipeline` in `ask-pipeline.ts`, with per-source failure isolation (notice cards), cache short-circuiting, run-artifact persistence, and protocol event emission.

Search is strategy-based through `selectSearchProvider()` and concrete providers in `search/tavily.ts`, `search/brave.ts`, and `search/browser.ts`. Provider selection supports explicit override and `auto` fallback semantics, with keychain-backed API key lookup and browser fallback when no API key is present.

Fetching and extraction are handled by `HybridContentFetcher` (`fetcher.ts`) and `ReadabilityExtractor` (`readability.ts`) with resilient malformed-document handling. Summarization defaults to `RuleBasedSummarizer` (`summarizer.ts`) and the LLM seam is in place via `createLlmSummarizer()` (`llm-summarizer.ts`), which intentionally returns `null` under FEAT-007 gates so the feature remains fully usable with `LLM_PROVIDER=none`.

Output rendering is implemented in `card.ts` for terminal, JSON, and markdown report paths. Cache storage is implemented in `cache.ts` and `cache-key.ts` with UTC-day scoping, TTL enforcement, and size-cap eviction.

CLI integration is implemented in `apps/cli/src/commands/ask.ts` and wired through `apps/cli/src/index.ts`/`apps/cli/src/bin.ts`. The command supports `--json`, `--no-llm`, `--no-cache`, `--search-provider`, `--limit`, `--fetch-timeout`, `--budget-ms`, and `--budget`.

Verification coverage includes extraction unit suites under `packages/core/tests/extraction`, CLI ask command tests under `apps/cli/src/commands/ask.spec.ts`, and ask-focused E2E tests in `e2e/ask.spec.ts` and `e2e/ask-no-llm.spec.ts`.

## Recorder

### Recorder Phase 1 (FEAT-008)

FEAT-008 is implemented across `packages/protocol/src/schemas/recording-draft.ts` and `packages/core/src/workflow/recorder/`. A `RecordingSession` orchestrates a visible Chrome browser session (via puppeteer-core), injects a CDP overlay script into every page, and produces a `draft.json` artifact containing all captured user actions.

The **protocol schema** (`RecordingDraftSchema`, `CapturedActionSchema`) lives in `@yantra/protocol` and enforces the redaction guarantee at the type level: `fill.raw_value` is `z.literal('<redacted>')`, so any attempt to persist an unredacted fill value is a compile-time error. The pre-redaction types (`RawCapturedActionInput`, `RawFillAction`) are internal to the `redactor.ts` module and not re-exported from the recorder barrel.

The **overlay** (esbuild IIFE bundle, built with `pnpm --filter @yantra/core build:recorder-overlay`) runs in-page and captures `click`, `input` (250 ms debounce), `change`, and `keydown(Enter)` events. For each captured action it calls `buildElementDescriptor()` (ARIA role + accessible name + sanitized attr sample + XPath debug string) and forwards the payload to Node via a CDP `Runtime.addBinding` channel. The overlay also draws a fixed-position recording indicator (red dot + action counter) and advises the user to "stop with Ctrl+C in the terminal".

The **redactor** (`DefaultCaptureRedactor`) is the only code that reads `raw_value`; it replaces it with the sentinel `'<redacted>'` and records `value_length` (code-point count). Defense-in-depth `defangAttrValue()` strips credential-shaped strings (sk-, sk-proj-, ghp_, AKIA, eyJ, xoxb-, gho_, glpat-) from element attribute samples before they are persisted.

**Session lifecycle**: `RecordingSession.start(name)` generates a time-ordered recording ID, calls `RecordingStore.create()`, launches Chrome headful, registers the CDP binding and overlay, sets up popup attachment (`PopupHandler`), cross-origin iframe detection, and starts the `IdleWatcher` (default 5-minute timeout, fires `IdleTimeoutPromptEvent`). `RecordingSession.stop(reason)` assembles and Zod-validates the draft via `assembleDraft()`, writes it atomically to `draft.json`, removes the partial draft, closes the browser, and destroys the ephemeral profile unless `keepProfile` was set. `abort()` preserves the profile for post-mortem.

**Crash safety**: `appendAction` + `FileSystemRecordingStore` write `draft.partial.json` atomically (`.tmp` + `fs.rename`) after every captured action. If the process crashes before `stop()`, the partial draft survives on disk.

**Tests** (all tagged `@no-llm`): 66 unit tests across `redactor.spec.ts` (incl. 500-run fast-check property test), `descriptor-builder.spec.ts` (jsdom, 22 tests), `draft-builder.spec.ts` (10 tests), `store.spec.ts` (8 tests), `idle-watcher.spec.ts` (7 fake-timer tests), `session.spec.ts` (4 integration + state-machine tests).

## Security Envelope

### Security Envelope (FEAT-006)

FEAT-006 is implemented across `packages/core/src/sanitizer`, `packages/core/src/secrets`, `packages/core/src/audit`, and `scripts/ci-static-check.ts`. The sanitizer now has a single chokepoint `sanitize(payload, profile, hostHint?)` with deterministic transform ordering, profile matrix (`public`, `read-only-data`, `authenticated`), host override support, transformation tagging, and UTF-8-safe truncation. The `llm_summarize` handler in the executor sends `sanitized.text`, ensuring LLM-bound content flows through the sanitizer path.

Secret handling is now centralized through the opaque resolver/keychain boundary. `DefaultOpaqueRefResolver` resolves `ValueRef` variants and emits secret-resolution metadata (never secret values), `createKeychainProvider()` returns either a keytar-backed provider or a degraded unavailable provider with one-shot warning logging, and `withSecret` provides best-effort in-memory zeroing semantics for transient secret usage.

Contextual scope enforcement is now a shared core primitive: `packages/core/src/secrets/scope-enforcer.ts` validates plans and rejects mutating behavior in `read-only-data` scope, while the executor wrapper delegates to it and maps violations into executor-level errors.

Audit output is now complete for the FEAT-006 surface. `JsonlAuditLogWriter` appends `agent.jsonl` and `secrets.jsonl` entries, writes scope-summary data into run manifests, and `FilesystemReportBuilder` renders a readable `report.md` from run artifacts. The CI guard `security:static-check` is wired to `scripts/ci-static-check.ts`, which enforces sanitize-before-send and package-boundary restrictions for `pi-agent-core` imports.

Verification coverage includes targeted FEAT-006 suites (12 files / 48 tests) covering sanitizer transforms/profiles/truncation/host overrides, keychain and resolver behavior, scope enforcement, secret zeroing, audit writer/report builder, and static-check fixtures. Property-based tests are in place for sanitizer invariants, query/token stripping, UTF-8 truncation safety, scope validation, and JSONL parseability.
