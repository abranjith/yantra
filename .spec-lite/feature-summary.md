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
