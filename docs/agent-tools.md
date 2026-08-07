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
  -> record model-supplied values (never re-redacted from its own results)
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
- **Cancellation:** a run-level abort (user interrupt or fatal budget
  exhaustion) aborts the run. A per-tool timeout aborts only that operation's
  `AbortSignal` and returns a retryable `TOOL_TIMEOUT` result; the model may use
  other tools or retry. Repetition of the same tool/error pair is bounded by
  `--tool-retries`.

### Hiding sensitive data from the model

Three layers decide what the model sees, and they are separated by **who owns
the value**, not by what shape it has. Every model-visible tool result passes
through all three, in this order, inside `sanitizeAndBound`:

| Provenance                                            | Mechanism             | Token the model sees | Reversible |
| ----------------------------------------------------- | --------------------- | -------------------- | ---------- |
| The **user's** marked/detected values (goal, profile) | `UserInputVault`      | `{{user:email:1}}`   | yes        |
| The **model's** own tool-call inputs                  | `ModelSuppliedValues` | the value, unchanged | n/a        |
| **Third-party** page/document content                 | profile strippers     | `[redacted-email]`   | no         |

The middle layer is what keeps the other two honest. A value the model typed
into a tool call is already in its context window, so redacting it out of the
result of that call — or out of a page it observes later in the same run —
protects nothing and destroys the agent's ability to verify its own work. The
observed failure: an agent navigated to `?tracknumbers=874426145172`, got
`?tracknumbers=[redacted-phone]` back, could not tell success from failure,
retried, and published a false claim that the runtime had broken. Preservation
is run-scoped for the same reason: `browser_observe` takes no parameters, and
the page carrying the answer is read several calls after the value was typed.

Preservation can never widen what the model learns: entries come only from
tool-call parameters the model itself authored, recorded **before** placeholder
resolution, and are shielded only where they occupy a whole token (so a
preserved fragment can never blunt a redactor matching a longer number around
it).

- **Tools act on real values.** The middleware resolves placeholders in tool
  params at the execution boundary — a `browser_fill` of `{{user:email:1}}`
  types the actual address into the page. This mirrors opaque secret refs:
  values materialize at execution, never in model-visible text.
- **The model only ever sees tokens.** Every model-visible result (success
  payloads, failure messages, details) is masked back: an echoed real value
  becomes its stable placeholder again before the profile sanitizer runs. The
  per-run prompt states this round trip explicitly, because a placeholder
  echoed in an observed URL or field is easily misread as proof that the
  runtime failed to substitute — it is proof of the opposite.
- **Explicit markers are the guarantee.** `@{value}` and tagged forms such as
  `@password{value}` become protected segments before any heuristic runs;
  keyword look-around and shape detection can never inspect them. Heuristics
  remain best-effort and conservative so a tracking or order number is not
  swallowed by a shape guess. See
  [User-input masking](user-input-masking.md) for grammar and boundaries.
- **Guards still apply.** A credential-shaped user value resolved from a
  placeholder is rejected by `browser_fill` exactly like a raw credential
  literal (`SECRET_SHAPED_LITERAL`); URL policy scans the resolved URL.
- **Artifacts stay redacted.** The trace (`trace.json`) and tool-call audit
  records keep the placeholder form, never the raw value; promoted workflows
  replace known placeholders with `[user-provided <tag>]`.
- **The model is told all of this.** The per-run prompt carries a short
  `Hidden values:` block naming both vocabularies and the self-supplied
  exemption. It is not optional politeness: a model that meets either token
  unexplained treats it as a runtime bug and spends its budget on it.

### Confirmation semantics

A confirmation is a **bounded blocking wait** inside the executing tool while the
provider connection stays open. The wall-clock budget keeps ticking; on timeout
the tool fails closed with `CONFIRMATION_TIMEOUT`, and an explicit denial returns
a `denied` result (`CONFIRMATION_DENIED`). Non-interactive connectors never
present a wait — they fail closed immediately. None of the four initial tools
require confirmation (they are read-only or the terminal publish); the machinery
exists for the browser tools (FEAT-025).

## Budgets

Budgets are enforced runtime configuration, not prompt promises. Shared
user-configurable defaults are documented once in the canonical
[Agentic options](model-configuration.md#agentic-options) table. Additional
non-flag safety bounds are:

| Bound                          | Default     | Behavior                                                                |
| ------------------------------ | ----------- | ----------------------------------------------------------------------- |
| Soft wall-clock wind-down      | 80% (`12m`) | Stops new exploration and tells the model to publish existing evidence. |
| Agent-visible bytes per result | 24 KB       | Bounds one sanitized tool result.                                       |
| Agent-visible bytes per run    | 512 KB      | Refuses further non-terminal result volume.                             |
| Browser navigations            | 30          | Refuses a navigation after the cap.                                     |
| Distinct outbound hosts        | 20          | Refuses a new host after the cap.                                       |

The provider-token ceiling and hard wall-clock deadline are run-fatal. The
byte, navigation, and host bounds fail the affected call with a typed
`BUDGET_EXHAUSTED` result while leaving the session alive to publish. Tool-call
counts remain in budget snapshots and audit artifacts, but are not caps; useful
work does not stop merely because a command-specific call quota was reached.

`result_publish` is exempt from the soft wind-down and cumulative result-byte
cap so completed work can become an artifact. The hard wall-clock deadline still
binds it.

The three default time bounds are deliberately related: `--tool-timeout 3m`
with `--tool-retries 3` permits the initial attempt plus three retries, reaching
12 minutes exactly when the 15-minute run enters its 80% wind-down. An
always-timing-out tool therefore receives retryable failures, then the runtime
steers the model to publish before the hard deadline. Each timeout remains in
`tool-calls.jsonl`; evidence collected before it stays in the publication
ledger.

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

## URL provenance (`browser_navigate`)

The URL policy asks _"is this URL safe to visit?"_. Provenance asks a different
question: _"where did this URL come from?"_

A model that cannot reach a page through the interface will try to reach it by
construction. In run `20260803T033803Z-do-f1d9f01b` the agent gave up on a search
form and hand-built a Kayak deep link containing a **fabricated city id**. The
site did not error — it served _"Shook, Missouri"_, eight cabins at a lake, under
`status: ok`. Nothing flagged it, and the run published hotel prices for a place
the user had never heard of. A guessed URL that 404s is a nuisance; a guessed URL
that resolves to plausible-looking wrong data is a correctness hole that no
downstream verification closes, because every later observation faithfully
reports the wrong page.

So each run keeps an append-only record (`runtime/url-provenance.ts`) of every
URL some tool result actually produced, and `browser_navigate` refuses anything
absent from it with **`URL_NOT_FROM_EVIDENCE`** (retryable):

> This URL introduces a path or parameter name that no search result or visited
> page attested. Query values on an already-visited URL may vary; new paths,
> parameter names, and identifiers still require `web_search` or a click-through.

The check runs **before** the URL policy, because `check()` reserves navigation
and host budget and a refused guess must not consume it.

**Seeded from trusted input** — every URL written in the user's own goal, and
every `--allow-host` entry. A user-named host is granted in full (any path,
scheme, and port): naming it is an explicit human statement of where the run
should work, and is itself the attestation that the host is correct. The failure
this guards against was a fabricated path on a host the user never named, reached
organically mid-run — that case is unaffected.

**Extended by tool results** — `web_search` hits including the `more_results`
tail, successfully fetched `web_fetch` pages, the post-redirect URL of every
completed navigation, and intercepted popup targets.

Matching for these earned URLs is deliberately a little generous, since a false
refusal costs a turn while a false accept costs correctness: host and scheme are
case-insensitive, the fragment is ignored, one trailing slash on a non-root path
is insignificant, and the bare origin of any visited page always matches
(clicking a site's logo is always available). For a visited origin + path, the
candidate's query parameter **names** must be a subset of names previously seen
there; their values may vary. A new path or parameter name remains refused —
precisely where a fabricated id hides.

`web_fetch` is deliberately **not** provenance-gated: following a URL quoted in
page text is a legitimate `ask`/`research` flow, and page text is not provenance.
Gating it needs its own design.

## The initial tools

`ask`, `research`, and `do` share the same wrappers and audit projection, but do not receive the same capabilities. `ask` is web-only and may only list saved workflows; `research` is web-only unless `YANTRA_AGENT_RESEARCH_BROWSE=1` explicitly enables read-only browsing; only `do` receives browser mutation tools. This is capability removal at registration time, not a prompt-only restriction.

| Tool                | What it does                                                                                                                                 | Key constraints                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_search`        | Search the public web and return the top hits **with their extracted page content** and references, plus a snippet-only `more_results` tail. | Combined search-that-fetches: fetches the top `search.fetch_top` hits (1–5, default 3) through the same per-source path as the deterministic pipeline. Every fetched URL passes the URL policy and ethics gate individually; per-site failures are data (`failures[]`), never a whole-tool error. Snippets **and** fetched content are untrusted, sanitized before the model sees them; oversized site text becomes a capture reference. |
| `web_fetch`         | Fetch + extract readable article text from **one specific public URL** you already have.                                                     | Secondary to `web_search` (which already returns page content for a query): use it only for a direct link or a link discovered inside previously fetched content. URL policy, ethics gate (robots/blocklist/rate limit), content-type allowlist, streamed size limit; large content becomes a capture reference.                                                                                                                         |
| `browser_navigate`  | Lazily open the single run page at a policy-checked URL and return its fresh observation.                                                    | Origin + path + parameter names must be attested by a tool result or goal; query values may vary. `--allow-host` grants the user-named host. URL/host budgets and ethics checks run before navigation.                                                                                                                                                                                                                                   |
| `browser_observe`   | Read bounded page text and ranked opaque refs without acting.                                                                                | Side-effect free. Action tools already return a fresh observation, so use this for an independent read rather than chaining it after every action. Refs stay stable on the same document and reset on navigation.                                                                                                                                                                                                                        |
| `browser_click`     | Click an actionable opaque ref and return the post-click observation.                                                                        | Dispatched as a user-shaped held press. Late navigation, redirects, and fetch/XHR updates settle before the observation is captured. Hidden, disabled, and stale targets return structured errors; protected actions require confirmation. A post-action read failure omits `observation` without changing a successful click into failure.                                                                                              |
| `browser_fill`      | Fill an observed field and return the post-fill observation.                                                                                 | Accepts a literal, `{{user:...}}` placeholder, or host-bound secret reference. Native `<select>` uses option label/value. Credential-shaped literals are refused; secret refs require confirmation. A successful fill never returns/logs its supplied value, and a post-action read failure only omits `observation`.                                                                                                                    |
| `browser_form_fill` | Fill several fields of one form in a single call, addressing them by visible name and re-observing between steps. **`do` only.**             | Never submits and never handles credentials (no `secret_ref` form; credential-shaped values are refused). Resolves each field against a fresh uncapped observation, so autocomplete options and calendar days revealed by the previous step are addressable. Stops at the first failing field and reports what was applied. Returns the post-fill observation so the submit button can be clicked with `browser_click`.                  |
| `browser_extract`   | Extract current-page content (`kind:"content"`, the default) or the first table (`kind:"table"`).                                            | Common synonyms resolve; any other kind is a retryable `INVALID_INPUT` naming the accepted kinds. Output is schema-checked and sanitized; oversized data becomes a capture reference plus preview. A `content` extraction also records the page in the evidence ledger, so a browser-driven run cites the pages its answer came from.                                                                                                    |
| `script_run`        | Run a named, allowlisted transformation script.                                                                                              | Registered ids only, validated args, out-of-process with time/memory/output caps.                                                                                                                                                                                                                                                                                                                                                        |
| `workflow_run`      | Discover (`mode:list`) and run (`mode:run`) a saved deterministic workflow.                                                                  | Catalog is secret-free (name/description/params/hosts only); a run replays through the deterministic executor with no LLM, in its own nested run directory, returning a sanitized status/outputs summary plus the nested `run_id`.                                                                                                                                                                                                       |
| `result_publish`    | Publish the final result content; complete the task.                                                                                         | Yantra builds and validates the formal Brief from agent content; sources attach automatically from the run's evidence ledger (every site `web_search`/`web_fetch` returned plus every page `browser_extract` read), so the model never re-types URLs; exactly one successful publication; closes the action phase.                                                                                                                       |

Web tool outcomes also feed Yantra's local domain-ranking signal: search hits
add a positive observation, while blocked, failed, or unreadable pages add a
negative one. Recording is best-effort and never changes the tool result. Only
normalized domains are stored locally—never URLs, queries, or page content.

Prefer `workflow_run` over ad-hoc browsing whenever a saved workflow matches the
goal: it replays reliably and cheaply with no model involvement. The agent never
sees a workflow's secrets or internal locators, and must never pass secret values
as workflow params.

### `browser_form_fill` — multi-field forms

`browser_fill` sets one field addressed by an opaque ref from the model's last
observation. A real search form defeats that in two compounding ways:

- The elements that matter often appear **because of** the previous step.
  Autocomplete suggestions and calendar days do not exist when the model last
  observed, so it has no ref for them.
- The model-visible observation is capped at 50 elements. Open dialog/widget
  scope ranks ahead of page chrome, with stable `(top, left)` ordering inside
  each scope.

In run `20260803T033803Z-do-f1d9f01b` the agent filled a destination box and then
clicked what it believed was the suggestion. It was a marketing tile — _"View
more deals for Chicago Hotels"_. The real options were `[role="option"]` elements
the scanner did not even select. The check-in/check-out fields were
`role: button` opening a calendar widget, not fillable inputs, so the agent never
solved them, gave up, and assembled a URL instead.

`browser_form_fill` takes an ordered `fields` array (1–10) of
`{ field, value, pick_suggestion? }` and, for each in turn:

1. re-observes the live page **uncapped** (internal resolution only — the
   model-visible surface is unchanged) and resolves `field`, which may be a
   visible name (exact, then prefix, then substring) or an `eNN` ref;
2. dispatches on the resolved element's role — text/search/combobox fields are
   typed into (a native `<select>` still routes through the controller's option
   matching, so `OPTION_NOT_FOUND` surfaces unchanged); a **button** is treated
   as a widget: click to open, re-observe, then click the matching choice;
3. when `pick_suggestion` is true, polls for a real `role="option"` element for
   up to 3 s and clicks the closest match — only page-declared options are
   eligible, so a same-named marketing tile can never win.

An ISO date value (`"2026-08-05"`) is matched against a full rendered date or a
bare day number whose `group` identifies the target month (and year, when the
group supplies one). Identical day numbers without group context are ambiguous
and never guessed. When the month is not visible, the tool chooses a
`Next month`/`Previous month` control from observed month groups and pages at
most 12 times. After clicking the day it re-reads the trigger and returns
`resulting_value`; an unchanged trigger is `FORM_WIDGET_NO_EFFECT`.

**It stops at the first failing field** and returns the fields applied so far
alongside the typed error — it never continues past a failure and never
substitutes a guess. Ambiguity is an error too: `"Check-"` matching both
"Check-in" and "Check-out" returns `FORM_FIELD_AMBIGUOUS` rather than silently
filling the wrong date and looking like success.

| Error                         | Meaning                                                                   |
| ----------------------------- | ------------------------------------------------------------------------- |
| `FORM_FIELD_NOT_FOUND`        | No field matches; lists up to 8 available names.                          |
| `FORM_FIELD_AMBIGUOUS`        | Several fields match at the winning tier; lists them.                     |
| `FORM_FIELD_UNSUPPORTED_ROLE` | Checkbox/radio or a non-fillable element — use `browser_click`.           |
| `FORM_WIDGET_NO_MATCH`        | The widget opened but nothing in it matches the value.                    |
| `FORM_WIDGET_NO_EFFECT`       | A widget choice clicked, but the trigger's rendered value did not change. |
| `SUGGESTION_NOT_OFFERED`      | No autocomplete option appeared within the wait window.                   |
| `SECRET_SHAPED_LITERAL`       | A credential-shaped value; use `browser_fill` with a `secret_ref`.        |

**Boundaries.** It never submits — the returned observation includes the submit
button and the model clicks it with `browser_click`, which keeps the
protected-action confirmation path exactly where it already was. It never
resolves credentials: there is no `secret_ref` form, so `browser_fill` remains
the sole credentialed fill path. Use `browser_fill` for a single field.

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

These caps are sized to ~60s (`packages/core/src/browser/agent-controller.ts`):
`browser_navigate`'s own page load, the post-action settle cap
(`POST_ACTION_TOTAL_WAIT_MS`), the read-settle cap for `browser_observe`/
`browser_extract` (`READ_SETTLE_TOTAL_MS`), and the network-quiet tail
(`NETWORK_QUIET_TIMEOUT_MS`, always clamped to whatever remains of the caller's
overall deadline) are all ~60s — a real-world result page (for example, a
carrier tracking page) commonly takes 10-30s to populate its content via an
async fetch after the initial load, and a shorter cap reports the empty/loading
shell as the final result instead of waiting for the real one.

These are ceilings, not the cost of a call: a settled page returns in well
under a second. Keeping them ceilings is why the network-quiet wait counts
in-flight requests itself rather than reading Puppeteer's counter. Two kinds of
request would otherwise never clear and would make every call pay the full cap:
renderer-served URLs (`blob:`, `data:`, `filesystem:`), whose completion is
reported to the consuming context rather than the page — the blob-backed
workers that bot-protection and analytics bundles spawn on most commercial
sites — and requests still open after `INFLIGHT_STALE_MS`, which are streams
the page is holding open (SSE, long-poll, a hanging beacon) rather than the
action's outcome.

Browser interaction follows an **observe → act-with-fresh-observation** loop.
`browser_navigate`, `browser_click`, and `browser_fill` return an `observation`
after successful action/settling; a failed best-effort read omits that key
without changing action success. `browser_observe` remains the independent
read-only operation.

An observation contains `url`, `title`, up to 50 ranked `interactables`, and a
page `digest`. When the digest is byte-identical to the prior model-visible read
of the document, `digest` is omitted and `digest_unchanged: true` is returned;
use `browser_extract` with `kind: "content"` to explicitly re-read full page
text. Internal uncapped form-resolution reads do not consume this digest state.

Each interactable always has `{ref, role, name}` and may add `group`,
`disabled: true`, `value`, `value_present: true`, `checked`, `expanded`, or
`selected`. Falsey/empty fields are generally omitted (`expanded: false` and
other explicit ARIA state remain meaningful). `group` is the nearest labelled
widget/container, including a calendar month heading. Visible open dialogs,
listboxes, menus, and grids rank before page scope; each scope then uses stable
`(top, left)` order. Password, one-time-code, and payment-secret field contents
are never read in-page: only `value_present: true` may reveal that one is set.
All other values still pass user-input masking and the selected sanitizer before
the model sees them.

Refs are opaque and belong only to the current run and page. A ref stays valid
from the observation that minted it until the main frame navigates to a new
document; successful actions do not invalidate sibling refs, and re-observing
the same document keeps stable ids. A ref whose node left the DOM, or one from a
departed document, returns `STALE_ELEMENT_REF` with guidance to use the fresh
action observation or read again. CSS, XPath, DOM ids, and arbitrary JavaScript
are never accepted from the model.

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
return, and every page a `browser_extract` content extraction read, is recorded
in the run's evidence ledger (URL, title, excerpt, fetch and publication
timestamps, sanitized and bounded; first sighting of a URL wins). Browser pages
belong there for the same reason search hits do — a `do` run that clicks through
to a price and extracts it drew its answer from that page, and a Brief that
instead cites only the search hop is not describing where its facts came from.
When the ledger has entries,
`result_publish` attaches those entries — with excerpts — as the Brief's
sources in consulted order and **ignores** model-supplied `sources`; findings
are published as editorial commentary (ad-hoc per-call citation numbers are
stripped rather than mis-attributed against run-wide numbering). Because that
makes _every_ finding editorial, the renderers show the editorial mark only when
a Brief also carries a cited finding — the flag stays in `brief.json`, but a
badge on every bullet is decoration, not information. Small local models cannot
reliably round-trip URLs from earlier tool results into a typed payload —
observed failures include placeholder `"N/A"` sources and a completion-nudged
re-search that changed the answer — so the model is never asked to courier data
the runtime already owns. Model-supplied sources are honored only when the
ledger is empty (a run that published without reading a page), where citation
integrity is validated as before. Internal callers may still
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
