# Agent Tool Runtime & Safety

Yantra's agentic commands expose a deliberately narrow, command-profiled set of tools to the model.
Every tool call runs through a **mandatory middleware pipeline** that the model and
the provider cannot bypass. This page documents the pipeline, the budgets, the
outbound-URL controls, the four initial tools, and how to add a new tool safely.

> Yantra is a browser-automation and web-research platform, not a general agent.
> There is no shell, filesystem, code-execution, or arbitrary-network tool. Pi's
> built-in `bash`/`read`/`write`/`edit`/`grep`/`find`/`ls` tools are disabled for
> every application session, and a runtime test asserts they never appear in the
> active tool catalog.

## The mandatory middleware pipeline

Every tool is wrapped by `wrapTool(spec, runServices)`, which composes these
stages **in order** (`packages/agent/src/runtime/middleware.ts`):

```text
validated call
  -> input validation (closed schema)
  -> user-input placeholder resolution ({{user:...}} -> real value)
  -> budget / timeout / abort check
  -> host + ethics + scope policy (+ action-phase latch)
  -> confirmation gateway (when the spec classifies risk)
  -> domain operation (AbortSignal threaded)
  -> user-input masking + sanitizer + output bounding
  -> stable tool result
  -> audit / event / usage persistence (via the run recorder)
```

- **Sanitization and confirmation are not tools.** The model cannot call them,
  skip them, or reorder them. Sanitization is the single chokepoint for every
  model-visible payload; confirmation is enforced immediately before a protected
  side effect.
- **Expected failures are structured tool results** carrying a stable machine
  `error_code` and a `retryable` flag (e.g. `SEARCH_PROVIDER_UNAVAILABLE`,
  `URL_CREDENTIAL_SHAPE`, `SCRIPT_NOT_FOUND`). The agent can read the code and
  adapt.
- **Unexpected exceptions are caught, audited, and genericized** to
  `TOOL_EXECUTION_FAILED` — no secret or raw page content ever leaks through an
  error message.
- **Cancellation:** a run-level abort (user interrupt or budget exhaustion) or a
  per-tool timeout aborts the domain operation's `AbortSignal` and returns a
  typed `aborted` / `TOOL_TIMEOUT` result promptly.

### User-input placeholders (`{{user:...}}`)

The user's own sensitive values (emails, phone numbers, SSNs, cards, API-key
shapes, auth-shaped URL query values) never reach the model as raw text. At run
start the goal and profile context are redacted through the run-scoped
`UserInputVault` (`@yantra/core`), which replaces each value with an indexed
placeholder such as `{{user:email:1}}` and remembers the mapping in memory.

- **Tools act on real values.** The middleware resolves placeholders in tool
  params at the execution boundary — a `browser_fill` of `{{user:email:1}}`
  types the actual address into the page. This mirrors opaque secret refs:
  values materialize at execution, never in model-visible text.
- **The model only ever sees tokens.** Every model-visible result (success
  payloads, failure messages, details) is masked back: an echoed real value
  becomes its stable placeholder again before the profile sanitizer runs.
- **Guards still apply.** A credential-shaped user value resolved from a
  placeholder is rejected by `browser_fill` exactly like a raw credential
  literal (`SECRET_SHAPED_LITERAL`); URL policy scans the resolved URL.
- **Artifacts stay redacted.** The trace (`trace.json`) and tool-call audit
  records keep the placeholder form, never the raw value.

### Confirmation semantics

A confirmation is a **bounded blocking wait** inside the executing tool while the
provider connection stays open. The wall-clock budget keeps ticking; on timeout
the tool fails closed with `CONFIRMATION_TIMEOUT`, and an explicit denial returns
a `denied` result (`CONFIRMATION_DENIED`). Non-interactive connectors never
present a wait — they fail closed immediately. None of the four initial tools
require confirmation (they are read-only or the terminal publish); the machinery
exists for the browser tools (FEAT-025).

## Budgets

Budgets are configuration, not prompt promises (`runtime/budget.ts`,
`DEFAULT_BUDGET_LIMITS`). The `BudgetTracker` enforces, per run:

| Budget              | Default   | Meaning                                                                                                                                                      |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wallClockMs`       | unlimited | Total wall-clock time for the run. Unbounded by default (local models are slow); cap it explicitly with `--budget-ms` or `YANTRA_AGENT_<COMMAND>_BUDGET_MS`. |
| `totalToolCalls`    | 60        | Tool calls across all tools.                                                                                                                                 |
| `perToolCalls`      | 25        | Calls to any single tool (overridable per tool).                                                                                                             |
| `perToolTimeoutMs`  | 45 s      | Execution timeout for one tool call.                                                                                                                         |
| `maxBytesPerResult` | 24 KB     | Agent-visible bytes in one tool result.                                                                                                                      |
| `maxBytesPerRun`    | 512 KB    | Cumulative agent-visible bytes for the run.                                                                                                                  |
| `maxNavigations`    | 30        | Browser navigations (FEAT-025).                                                                                                                              |
| `maxHosts`          | 20        | Distinct outbound hosts.                                                                                                                                     |

Exhaustion returns a typed `BUDGET_EXHAUSTED` decision that the orchestrator maps
to a clean run abort.

## Outbound URL policy (`web_fetch`, `browser_navigate`)

Outbound URLs are the acknowledged injection-exfiltration channel. Prompt-injected
page content can _request_ a fetch, but it cannot make one invisibly or
unboundedly (`runtime/url-policy.ts`). Every candidate URL is:

1. **length-capped** (default 2 KB) — checked before parsing;
2. **scheme-restricted** to https (http rejected by default);
3. **scanned for credential-shaped substrings** (`sk-`, `ghp_`, `AKIA`, `eyJ…`
   JWTs) — a match is refused structurally with `URL_CREDENTIAL_SHAPE`, never
   echoing the matched value;
4. **counted against the per-run host / navigation budget** — a new host
   decrements the host budget.

Every decision — allow or reject — is audited in full.

## The initial tools

`ask`, `research`, and `do` share the same wrappers and audit projection, but do not receive the same capabilities. `ask` is web-only and may only list saved workflows; `research` is web-only unless `YANTRA_AGENT_RESEARCH_BROWSE=1` explicitly enables read-only browsing; only `do` receives browser mutation tools. This is capability removal at registration time, not a prompt-only restriction.

| Tool               | What it does                                                                                                                                 | Key constraints                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_search`       | Search the public web and return the top hits **with their extracted page content** and references, plus a snippet-only `more_results` tail. | Combined search-that-fetches: fetches the top `search.fetch_top` hits (1–5, default 3) through the same per-source path as the deterministic pipeline. Every fetched URL passes the URL policy and ethics gate individually; per-site failures are data (`failures[]`), never a whole-tool error. Snippets **and** fetched content are untrusted, sanitized before the model sees them; oversized site text becomes a capture reference.                      |
| `web_fetch`        | Fetch + extract readable article text from **one specific public URL** you already have.                                                     | Secondary to `web_search` (which already returns page content for a query): use it only for a direct link or a link discovered inside previously fetched content. URL policy, ethics gate (robots/blocklist/rate limit), content-type allowlist, streamed size limit; large content becomes a capture reference.                                                                                                                                              |
| `browser_navigate` | Lazily open the single run page at a policy-checked URL.                                                                                     | URL/host budgets and ethics checks run before navigation.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `browser_observe`  | Return bounded readable text and ranked opaque refs.                                                                                         | Side-effect free; creates a new ref generation and invalidates the prior one.                                                                                                                                                                                                                                                                                                                                                                                 |
| `browser_click`    | Click an actionable opaque ref.                                                                                                              | Dispatched as a user-shaped held press. The result is held until the page stops moving: late-starting navigations, redirect chains, and fetch/XHR updates settle (bounded) before the next tool call can race them. Hidden, disabled, and stale targets return structured errors; a covered target is clicked through to whatever covers it, exactly as a real user's click would be — re-observe to see the outcome. Protected actions require confirmation. |
| `browser_fill`     | Fill an observed field with a literal, a `{{user:...}}` placeholder, or a website secret reference.                                          | Native `<select>` elements are filled by option label or value (`OPTION_NOT_FOUND` otherwise); text fields are overtyped with real key events. `{{user:...}}` placeholders resolve to the real user-provided value at the execution boundary; credential-shaped literals (raw or resolved) are rejected; secret refs require confirmation and trusted host metadata.                                                                                          |
| `browser_extract`  | Extract current-page content (`kind:"content"`, the default) or the first table (`kind:"table"`).                                            | Common synonyms resolve; any other kind is a retryable `INVALID_INPUT` naming the accepted kinds. Output is schema-checked and sanitized; oversized data becomes a capture reference plus preview.                                                                                                                                                                                                                                                            |
| `script_run`       | Run a named, allowlisted transformation script.                                                                                              | Registered ids only, validated args, out-of-process with time/memory/output caps.                                                                                                                                                                                                                                                                                                                                                                             |
| `workflow_run`     | Discover (`mode:list`) and run (`mode:run`) a saved deterministic workflow.                                                                  | Catalog is secret-free (name/description/params/hosts only); a run replays through the deterministic executor with no LLM, in its own nested run directory, returning a sanitized status/outputs summary plus the nested `run_id`.                                                                                                                                                                                                                            |
| `result_publish`   | Publish the final result content; complete the task.                                                                                         | Yantra builds and validates the formal Brief from agent content; sources attach automatically from the run's evidence ledger (every site `web_search`/`web_fetch` returned), so the model never re-types URLs; exactly one successful publication; closes the action phase.                                                                                                                                                                                   |

Web tool outcomes also feed Yantra's local domain-ranking signal: search hits
add a positive observation, while blocked, failed, or unreadable pages add a
negative one. Recording is best-effort and never changes the tool result. Only
normalized domains are stored locally—never URLs, queries, or page content.

Prefer `workflow_run` over ad-hoc browsing whenever a saved workflow matches the
goal: it replays reliably and cheaply with no model involvement. The agent never
sees a workflow's secrets or internal locators, and must never pass secret values
as workflow params.

## Browser session and observation model

Agentic browser use is run-scoped and lazy: Chrome starts on the first
`browser_navigate`, owns one page, and always uses a fresh ephemeral profile.
The profile is removed during normal completion, abort, or browser teardown.
Persistent/logged-in profiles are intentionally out of scope for this release.
Popups and new tabs are closed instead of adopted — whether declared
(`target=_blank`, inline `window.open`) or opened by dynamically wired event
listeners. The popup is given a bounded moment to reach its real URL (not
`about:blank`), and that URL is returned as `popup_intercepted` so a later
explicit navigation re-enters URL and ethics policy. JS dialogs are
auto-handled so they can never deadlock the page: `beforeunload` is accepted
(agent-initiated navigation proceeds), alert/confirm/prompt are dismissed —
never silently accepted — and the message is returned as `dialog_intercepted`.

Every action (navigate/click/fill) holds its result until the page has stopped
moving: a main-frame navigation watcher installed before the action catches
navigations the site starts late (async handlers, timer redirects, validation
then submit), waits bounded for the new document to commit and reach
DOMContentLoaded, follows client-side redirect chains, and finishes with a
bounded network-quiet wait so fetch/XHR-driven updates land before the next
observation. A page that never settles degrades to a result after the caps
rather than an error.

Browser interaction follows an **observe → act → re-observe** loop.
`browser_observe` returns sanitized bounded text plus ranked
`{ref, role, name}` entries. Refs are opaque and belong only to the current
run and page. A ref stays valid from the observation that minted it until the
main frame navigates to a new document; successful actions do not invalidate
sibling refs, and re-observing the same document keeps stable ids. A ref whose
node left the DOM, or one from a departed document, returns
`STALE_ELEMENT_REF` with guidance to observe again. CSS, XPath, DOM ids, and
arbitrary JavaScript are never accepted from the model.

### Website secret host bindings

Website secret metadata must include at least one allowed host. The binding is
trusted configuration/keychain metadata—not tool input—and is checked against
the live page before the value is resolved:

```yaml
kind: secret
key: shop.password
hosts:
  - shop.example.com
```

An exact host or another host under the same registrable domain is accepted;
unrelated domains return `SECRET_HOST_MISMATCH` before the resolver runs.
Existing non-browser secret references remain valid without `hosts`, but they
cannot be used by `browser_fill` until host metadata is added. The resolved
value exists only inside the executing fill, is never returned in tool results
or audit details, and is disposed immediately afterward.

### `web_fetch` constraints

- The **ethics gate is non-bypassable**: a robots/blocklist/rate-limit refusal
  returns a typed `ETHICS_BLOCKED` result. There is no evasion path and no
  `--ignore-robots` flag — Yantra honors blocks (honesty over cleverness).
- Only text content types (`text/html`, `text/plain`) are accepted; PDFs,
  images, and binaries are refused with `CONTENT_TYPE_REFUSED`.
- Bodies over the size limit are aborted mid-stream (`CONTENT_TOO_LARGE`).
- Extracted content larger than the capture threshold is written to
  `runs/<id>/captures/<ref>.txt` and referenced by id instead of dumped inline.

### `script_run` and the trust boundary

`script_run` never accepts an arbitrary command string. It accepts a **registered
id** plus arguments validated by that script's own schema
(`packages/core/src/scripts/`). Each script is a pure, self-contained
transformation function; the executor runs it in a fresh `worker_threads` worker
with an enforced wall-clock timeout, an output-byte cap, and a best-effort memory
cap.

Registered scripts: `table_normalize`, `dedupe_lines`, `json_pick`.

> **Trust statement (honest):** Node cannot fully sandbox a worker — a worker
> still has the Node standard library. Yantra grants no network or filesystem
> access to a script (no handles or env are passed), and the scripts are trusted
> first-party code, so the security boundary is the **code-defined registry**,
> not OS-level isolation. The worker exists for _resource_ containment
> (time/memory/output), not to run untrusted code.

### `result_publish` — the completion contract

Raw chat prose is **not** a completed task. A user-facing agentic run completes
only when the agent calls `result_publish` with its result **content**:

```json
{
  "brief": {
    "title": "One-line answer title",
    "overview": "Answer-first Markdown (1-3 paragraphs).",
    "key_findings": ["an optional plain-string finding"]
  }
}
```

`title` and `overview` are **schema-required**: a call without them (or with an
empty title) is rejected as `INVALID_INPUT` naming the missing field before the
publisher runs, so even small local models get a structured retry path.
`key_findings` and `sources` are optional at the schema level.

**Sources are ledger-authoritative.** Every site `web_search` and `web_fetch`
return is recorded in the run's evidence ledger (URL, title, excerpt, fetch and
publication timestamps, sanitized and bounded). When the ledger has entries,
`result_publish` attaches those entries — with excerpts — as the Brief's
sources in consulted order and **ignores** model-supplied `sources`; findings
are published as editorial commentary (ad-hoc per-call citation numbers are
stripped rather than mis-attributed against run-wide numbering). Small local
models cannot reliably round-trip URLs from earlier tool results into a typed
payload — observed failures include placeholder `"N/A"` sources and a
completion-nudged re-search that changed the answer — so the model is never
asked to courier data the runtime already owns. Model-supplied sources are
honored only when the ledger is empty (for example browser-only `do` runs),
where citation integrity is validated as before. Internal callers may still
pass a complete protocol Brief (detected by `brief_id`/`schema_version`); it
passes through untouched and is validated as-is.

On success the tool writes `brief.json`, `brief.md`, and `brief.html` to the run
directory and closes the run's **action phase**. Exactly one successful
publication is allowed: a second attempt returns `ALREADY_PUBLISHED`, invalid
content returns a structured, retryable `BRIEF_INVALID` error whose issue
pointers match the submitted shape, and after a successful publish any later
_mutating_ tool call is rejected with `ACTION_PHASE_CLOSED` (read-only tools
remain available).

### Completion nudge, evidence freeze, and the deterministic fallback

When a session run ends in plain chat text with no publication, the runtime
sends one **completion nudge**. The nudge is built from run state, not a static
string: it recaps the consulted sources from the evidence ledger inline, states
that sources attach automatically, anchors the model's previous message as the
draft to publish, and instructs it not to gather more evidence. At the same
moment the runtime **freezes the evidence phase**: further `web_search` /
`web_fetch` calls are rejected with `EVIDENCE_FROZEN`, so the nudge turn is
structurally publish-only and a model can never re-investigate its way to a
different conclusion (the freeze is skipped when the ledger is empty, keeping a
failed first search retryable).

If the nudge turn still ends without a publication and the run holds both a
draft answer and ledger evidence, the runtime **assembles the Brief itself**:
the draft becomes the overview, the ledger becomes the sources, and the
assembly is stamped honestly (`metadata.deterministic_fallback_used: true` plus
a `notices` entry). The protocol invariant is unchanged — only a validated
Brief is a published result — what relaxes is authorship: the model supplies
prose, the runtime supplies structure. `AGENT_COMPLETION_MISSING` remains the
outcome only when there is no draft or no evidence to package.

## Adding a tool (contributor checklist)

A new tool is a provider-neutral `ToolWrapperSpec` plus one line in
`createYantraTools`. It must declare (all enforced by the contract test harness):

- [ ] a stable **snake_case name**, unique in the catalog;
- [ ] a **label** and a **description that states when to use it AND when NOT to**;
- [ ] a **closed** input schema (`additionalProperties: false`) with field
      descriptions and limits;
- [ ] a **sanitization profile** for the model-visible result;
- [ ] documented **side effects / confirmation behavior / reference lifetime**;
- [ ] stable machine **error codes** with a `retryable` flag;
- [ ] a domain operation that lives as an ordinary function in `@yantra/core`
      (the Pi wrapper stays thin) and threads the `AbortSignal`.

Register it in `packages/agent/src/adapters/pi/tools/index.ts`. The factory
enforces unique names and deterministic name-sorted ordering, which keeps the
`tool_catalog_hash` in the run manifest stable.
