# Feature Summary

Current-state reference for all implemented features. Updated by the Implement skill after each feature completes.

---

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
