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
  -> budget / timeout / abort check
  -> host + ethics + scope policy (+ action-phase latch)
  -> confirmation gateway (when the spec classifies risk)
  -> domain operation (AbortSignal threaded)
  -> sanitizer + output bounding
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

| Budget | Default | Meaning |
| --- | --- | --- |
| `wallClockMs` | 10 min | Total wall-clock time for the run. |
| `totalToolCalls` | 60 | Tool calls across all tools. |
| `perToolCalls` | 25 | Calls to any single tool (overridable per tool). |
| `perToolTimeoutMs` | 45 s | Execution timeout for one tool call. |
| `maxBytesPerResult` | 24 KB | Agent-visible bytes in one tool result. |
| `maxBytesPerRun` | 512 KB | Cumulative agent-visible bytes for the run. |
| `maxNavigations` | 30 | Browser navigations (FEAT-025). |
| `maxHosts` | 20 | Distinct outbound hosts. |

Exhaustion returns a typed `BUDGET_EXHAUSTED` decision that the orchestrator maps
to a clean run abort.

## Outbound URL policy (`web_fetch`, `browser_navigate`)

Outbound URLs are the acknowledged injection-exfiltration channel. Prompt-injected
page content can *request* a fetch, but it cannot make one invisibly or
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

| Tool | What it does | Key constraints |
| --- | --- | --- |
| `web_search` | Query the public web; returns ranked `{url, title, snippet}`. | Result cap; snippets are untrusted and sanitized before the model sees them. |
| `web_fetch` | Fetch + extract readable article text from one public page. | URL policy, ethics gate (robots/blocklist/rate limit), content-type allowlist, streamed size limit; large content becomes a capture reference. |
| `browser_navigate` | Lazily open the single run page at a policy-checked URL. | URL/host budgets and ethics checks run before navigation. |
| `browser_observe` | Return bounded readable text and ranked opaque refs. | Side-effect free; creates a new ref generation and invalidates the prior one. |
| `browser_click` | Click an actionable opaque ref. | Hidden, disabled, occluded, and stale targets return structured errors; protected actions require confirmation. |
| `browser_fill` | Fill an observed field with a literal or website secret reference. | Credential-shaped literals are rejected; secret refs require confirmation and trusted host metadata. |
| `browser_extract` | Extract current-page content or the first table. | Output is schema-checked and sanitized; oversized data becomes a capture reference plus preview. |
| `script_run` | Run a named, allowlisted transformation script. | Registered ids only, validated args, out-of-process with time/memory/output caps. |
| `workflow_run` | Discover (`mode:list`) and run (`mode:run`) a saved deterministic workflow. | Catalog is secret-free (name/description/params/hosts only); a run replays through the deterministic executor with no LLM, in its own nested run directory, returning a sanitized status/outputs summary plus the nested `run_id`. |
| `result_publish` | Validate and persist the final Brief; complete the task. | Exactly one successful publication; closes the action phase. |

Prefer `workflow_run` over ad-hoc browsing whenever a saved workflow matches the
goal: it replays reliably and cheaply with no model involvement. The agent never
sees a workflow's secrets or internal locators, and must never pass secret values
as workflow params.

## Browser session and observation model

Agentic browser use is run-scoped and lazy: Chrome starts on the first
`browser_navigate`, owns one page, and always uses a fresh ephemeral profile.
The profile is removed during normal completion, abort, or browser teardown.
Persistent/logged-in profiles are intentionally out of scope for this release.
Popups and new tabs are closed instead of adopted; their target URL is returned
as `popup_intercepted` so a later explicit navigation re-enters URL and ethics
policy.

Browser interaction follows an **observe → act → re-observe** loop.
`browser_observe` returns sanitized bounded text plus ranked
`{ref, role, name}` entries. Refs are opaque and belong only to the current run,
page, and observation generation. Navigation, reload, DOM changes, popup events,
an action, or a newer observation invalidates them; using one then returns
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
> not OS-level isolation. The worker exists for *resource* containment
> (time/memory/output), not to run untrusted code.

### `result_publish` — the completion contract

Raw chat prose is **not** a completed task. A user-facing agentic run completes
only when the agent calls `result_publish` with a Brief that validates against the
protocol Brief schema (which enforces citation integrity). On success the tool
writes `brief.json`, `brief.md`, and `brief.html` to the run directory and closes
the run's **action phase**. Exactly one successful publication is allowed: a
second attempt returns `ALREADY_PUBLISHED`, an invalid Brief returns a structured
`BRIEF_INVALID` error listing the offending references, and after a successful
publish any later *mutating* tool call is rejected with `ACTION_PHASE_CLOSED`
(read-only tools remain available).

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
