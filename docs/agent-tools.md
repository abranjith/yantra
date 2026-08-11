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
  params at the execution boundary — a `browser_fill_element` of `{{user:email:1}}`
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
  placeholder is rejected by `browser_fill_element` exactly like a raw credential
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

If the same normalized URL is refused again in one run, the message points to
the concrete grounded routes: submit the visible form with `browser_click`, or
open a search result. Repeating the guessed URL does not relax provenance.

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

| Tool                   | What it does                                                                                                                                 | Key constraints                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_search`           | Search the public web and return the top hits **with their extracted page content** and references, plus a snippet-only `more_results` tail. | Combined search-that-fetches: fetches the top `search.fetch_top` hits (1–5, default 3) through the same per-source path as the deterministic pipeline. Every fetched URL passes the URL policy and ethics gate individually; per-site failures are data (`failures[]`), never a whole-tool error. Snippets **and** fetched content are untrusted, sanitized before the model sees them; oversized site text becomes a capture reference. |
| `web_fetch`            | Fetch + extract readable article text from **one specific public URL** you already have.                                                     | Secondary to `web_search` (which already returns page content for a query): use it only for a direct link or a link discovered inside previously fetched content. URL policy, ethics gate (robots/blocklist/rate limit), content-type allowlist, streamed size limit; large content becomes a capture reference.                                                                                                                         |
| `browser_navigate`     | Lazily open the single run page at a policy-checked URL and return its fresh observation.                                                    | Origin + path + parameter names must be attested by a tool result or goal; query values may vary. `--allow-host` grants the user-named host. URL/host budgets and ethics checks run before navigation.                                                                                                                                                                                                                                   |
| `browser_observe`      | Read bounded page text and ranked opaque refs without acting.                                                                                | Side-effect free. Action tools already return a fresh observation, so use this for an independent read rather than chaining it after every action. Refs stay stable on the same document and reset on navigation.                                                                                                                                                                                                                        |
| `browser_click`        | Click an actionable opaque ref and return the post-click observation.                                                                        | Dispatched as a user-shaped held press. Late navigation, redirects, and fetch/XHR updates settle before the observation is captured. Hidden, disabled, and stale targets return structured errors; protected actions require confirmation. A post-action read failure omits `observation` without changing a successful click into failure.                                                                                              |
| `browser_fill_element` | Fill one field by visible name or current ref and return one post-action observation. **`do` only.**                                         | One semantic engine handles plain text, reactive suggestions, offered choices, toggles, ISO dates/ranges, native controls, and host-bound `secret_ref` values. Literal credentials and malformed dates fail before mutation. Success reports the verified `committed` value, winning `driver`, and `dismissed` state; secret success omits `committed`.                                                                                  |
| `browser_fill_form`    | Fill 1–10 non-secret fields in order and return one post-form observation. **`do` only.**                                                    | Accepts a literal string per field and resolves every field from a fresh internal observation. It emits one semantic trace step per success, stops at the first failure, reports the applied prefix, and releases the failed field's floating widget. Never submits; use `browser_fill_element` for credentials and `browser_click` on the returned submit/search control.                                                               |
| `browser_extract`      | Extract current-page content (`kind:"content"`, the default) or the first table (`kind:"table"`).                                            | Common synonyms resolve; any other kind is a retryable `INVALID_INPUT` naming the accepted kinds. Output is schema-checked and sanitized; oversized data becomes a capture reference plus preview. A `content` extraction also records the page in the evidence ledger, so a browser-driven run cites the pages its answer came from.                                                                                                    |
| `script_run`           | Run a named, allowlisted transformation script.                                                                                              | Registered ids only, validated args, out-of-process with time/memory/output caps.                                                                                                                                                                                                                                                                                                                                                        |
| `workflow_run`         | Discover (`mode:list`) and run (`mode:run`) a saved deterministic workflow.                                                                  | Catalog is secret-free (name/description/params/hosts only); a run replays through the deterministic executor with no LLM, in its own nested run directory, returning a sanitized status/outputs summary plus the nested `run_id`.                                                                                                                                                                                                       |
| `result_publish`       | Publish the final result content; complete the task.                                                                                         | Yantra builds and validates the formal Brief from agent content; sources attach automatically from the run's evidence ledger (every site `web_search`/`web_fetch` returned plus every page `browser_extract` read), so the model never re-types URLs; exactly one successful publication; closes the action phase.                                                                                                                       |

Web tool outcomes also feed Yantra's local domain-ranking signal: search hits
add a positive observation, while blocked, failed, or unreadable pages add a
negative one. Recording is best-effort and never changes the tool result. Only
normalized domains are stored locally—never URLs, queries, or page content.

Prefer `workflow_run` over ad-hoc browsing whenever a saved workflow matches the
goal: it replays reliably and cheaply with no model involvement. The agent never
sees a workflow's secrets or internal locators, and must never pass secret values
as workflow params.

### Widget drivers

Stateful controls are operated through one semantic fill engine in
`@yantra/core`. The engine parses text, option, toggle, date, and date-range
intents; chooses the standards-based path for the live control; performs bounded
actions; watches for post-type suggestions; verifies the committed value; and
releases any floating widget. Native select, listbox, calendar-grid, and date-input
drivers are internal strategies, not a model-visible tool registry. No path may
branch on a hostname, vendor class, or site-specific test id.

A target survives a framework replacing its DOM node. Every controller action
that accepts a ref (`click`, `fill`, and `evaluateOn`) catches only the typed
stale-ref error, re-observes once, and retries only when exactly one live element
has the same role, accessible name, and group. Zero matches reports that the
element left the page; multiple matches report the ambiguity and never guess.
Navigation and teardown clear these identities, and non-stale actionability or
policy failures pass through without a rescan. The fill engine adds one
field-name re-acquisition for longer widget operations whose accessible value
changes during commitment.

Before mutation, parsing and structural inspection are read-only. During
execution, open state is checked instead of assumed, and a control that was already open is not
toggled shut. Each operation is bounded by a deadline, action count, and (for
calendars) paging count. A driver reports success only after the control's own
rendered value matches the intent; ambiguity, an unsafe date mapping, or a click
that did not commit becomes a typed `WIDGET_*` failure carrying the observed
state.

Open state is decided from what is rendered, not from what the trigger claims.
`aria-expanded` counts only as a positive signal: many production triggers ship
it hard-coded to `"false"`, or update it on a different node than the one the
observation resolved. Trusting that over a container that is plainly on screen
inverts the whole operation — the driver concludes "closed", clicks to open,
and thereby closes the control it was asked to drive. A container is located
through `aria-controls`, `aria-owns`, then an `aria-haspopup` trigger's popup
sibling. When none of those declare the link, a driver already committed to a
target may fall back to a scan for a single unambiguously open popup; detection
never may, or an unrelated open dialog would make every field on the page look
like a date control.

A declared target must still look like a popup. Tabbed pickers routinely point
`aria-controls` at an empty tabpanel placeholder and render the panel's content
as a sibling, so a target with no children is treated as a label for the popup
rather than the popup, and resolution continues. A container counts as rendered
only with a non-zero width **and** height — an empty block-level element
stretches to its parent's width at zero height, and width alone would pass it.
Container scope is an optimization, not a safety property: a scoped calendar
read that finds no day cells means the container is wrong, not that the page has
no calendar, so the driver re-reads the document rather than reporting a visible
month unreachable. The guarantees that matter — a date matching exactly one
cell, the weekday cross-check, and refusing a disabled cell — run on whichever
read is used.

Option drivers cover native `<select>` controls, listbox/menu popups, and
typeaheads. Candidate collection does not require `role="option"`: buttons,
links, menu items, clickable list items, and homogeneous named siblings inside
the resolved popup are eligible. This matters on production autocomplete
widgets that expose suggestions as buttons. Matching proceeds through exact,
prefix, all-token, and substring tiers, and a tie in the winning tier is never
broken by guessing.

What a tie _means_ depends on the control. On one that cannot hold typed text —
a listbox, menu, or non-editable combobox — choosing is the whole point, so a
tie is `WIDGET_AMBIGUOUS_CHOICE` and nothing is clicked. On an editable control
the typed characters are already a valid commit: an editable combobox is a
search box, not a menu, so the suggestion list is released and the literal
stands. The result reports `driver: "plain-text"` rather than `"typeahead"`, so
a caller can tell no suggestion was taken. A site search offering seven equally
prefixed completions should not fail the fill that already typed the query.

Date drivers cover native/format-signalled date inputs and popup calendar
grids. Calendar cells are derived in a strict order: machine-readable date
attributes first, then a complete accessible date label, then the owning
month/year label plus the bare day number. The structural path cross-checks the
derived weekday against the cell's weekday-header column; any disagreement in
the target panel returns `WIDGET_MAPPING_UNSAFE` without clicking. Month paging
must advance monotonically toward the target and is capped at 12 steps.

The accessible date label is read from the cell's whole subtree, not from an
`aria-label` on the clickable element. Pickers routinely attach the full date to
an inert child and leave the bare number on the ancestor, with the number itself
`aria-hidden`:

```html
<div role="button">
  <div aria-label="Sunday, September 6, 2026"></div>
  <div aria-hidden="true">6</div>
</div>
```

Reading only the ancestor's own attribute discards the one unambiguous date on
the page and keeps the one string that cannot identify the cell — a two-month
panel offers several cells named `6`. The same rule governs the month/year
label, which is frequently a plain styled `<span>` rather than a `<caption>`,
heading, or `aria-label`; a preceding-sibling text node that parses as an exact
`Month YYYY` is accepted.

Only an `aria-hidden` wrapper **inside** the cell marks its label decorative.
The search deliberately does not walk past the cell: single-page apps put
`aria-hidden="true"` on an app-level container while an overlay is open, and
honouring that discards every date on the page. A cell that carries
`aria-hidden="true"` itself is read and marked **disabled** — that is how some
pickers express an out-of-range date, with no `aria-disabled` or `disabled`
attribute anywhere.

Committed dates are verified leniently about form and strictly about value. A
slashed numeric date is accepted in either field order, since the rendered text
carries no signal about its own. A widget that renders no year at all
(`Sun, Sep 6`) is matched on month and day; one that does render a year must
agree with it. When a range is spread across a check-in/check-out pair rather
than echoed into one trigger, both sides are read and both must hold their
endpoint — resolved only when exactly one control matches each side.

Verification happens **after** the widget is released, not before. A picker that
commits on release still reads its old value while open, and a paired range
cannot be read at all while the popup's duplicate copy of that pair is on the
page. The far side of a paired range is often written a beat after the near
side, so the post-release check polls briefly rather than reading once — only on
the path that would otherwise fail.

Releasing is part of committing, so the container a driver **operated** is
always released, whether or not it was already open when the fill arrived.
"Leave open whatever I found open" still governs a container no driver touched —
a modal the field merely sits inside — but applied to the picker being driven it
reported ranges as committed that the page had never accepted, because the
widget was still holding them in its own copy of the fields.

### A date range is one value, not two dates

Many sites spread one range over a check-in/check-out pair and commit **the pair
as a unit**: choosing one end clears the other, and closing the picker with only
one end set discards it and restores the previous range. Two independent
single-date fills therefore cannot work on such a widget, no matter how they are
retried — the first is thrown away by its own release before the second begins.

- Send both ends together. `browser_fill_form` collapses two dates into one
  range fill when the page resolves exactly one control per side and those are
  the two fields named; otherwise fields fill in order as usual.
  `browser_fill_element` takes the same range directly as
  `"YYYY-MM-DD..YYYY-MM-DD"`.
- A range is driven from the **opening** end even when the caller addresses the
  closing one. Opened from the closing field, these pickers read the first click
  as an end and the next as the start of a fresh range, so the right two days
  get selected and nothing commits.
- Half a range returns `WIDGET_RANGE_INCOMPLETE`, naming the partner field and
  the exact call that works, with the page left as it was found. Reported as
  `WIDGET_DISMISS_FAILED` — an uncooperative overlay — it read as a tool
  malfunction and sent callers off to click day cells by hand.

A page with a single-date picker, or two dates it does not label as a pair, is
unaffected by any of this.

### Recovering from a page that moves underneath the fill

Single-page sites re-mount controls constantly: opening a picker can replace the
trigger's node, push a new URL without loading a document, and mount a second
control carrying the same accessible name inside the popup. Each of those alone
is enough to lose a target mid-fill, so recovery is layered and bounded.

- A ref whose node has left the page is re-found by its recorded
  `(role, name, group)` identity, in the controller, for every tool that takes a
  ref — `browser_click` included.
- Identities survive an in-page route change and are discarded only when the
  document itself is replaced, which is detected by a marker on the document
  rather than inferred from the navigation event.
- Inside one fill, the engine re-acquires its target up to four times; opening a
  widget is itself a re-render, and a range clicks twice more.
- If a fill still reports `WIDGET_ELEMENT_REPLACED`, the tool re-resolves the
  field by name against a fresh observation and drives it once more.

Duplicates are ranked, not refused, whenever the control has **already** been
identified: the copies mirror each other, and the fill is verified end to end
afterwards. Choosing which field the caller _meant_ stays strict — `Check-in`
and `Check-out` share a prefix, and picking one would silently fill the wrong
date, so an ambiguous first resolution is still an error.

A range picker waiting to pair a start greys out every earlier date, so a
`disabled` opening endpoint is re-tested once against a freshly reopened widget
before it is reported unreachable.

Every fill failure carries a `hint` naming one concrete next step, and that hint
is appended to the message rather than left only in `details`. A caller that
sees a bare typed code tends to abandon the tool and operate the widget with raw
clicks, which is the behaviour these tools exist to replace.

Use the single-control tool for any field shape:

```json
{ "field": "Where to?", "value": "Frisco, Texas" }
```

is a `browser_fill_element` call. An Expedia-style range uses the same tool:

```json
{ "field": "Dates", "value": "2026-09-06..2026-09-08" }
```

The result returns `committed`, the winning `driver`, `dismissed`, and one
post-action observation. It preserves `WIDGET_*` error details verbatim so the next
attempt can respond to what the control actually offered or rendered.

| Goal                                               | Tool                   |
| -------------------------------------------------- | ---------------------- |
| Fill one text/secret/date/choice/toggle field      | `browser_fill_element` |
| Fill several fields in order                       | `browser_fill_form`    |
| Activate a button, link, toggle, or submit control | `browser_click`        |

The fill tools verify the committed value themselves. Do not follow a
successful call with `browser_observe` solely to confirm it, and do not operate
a dropdown or calendar one `browser_click` at a time.

The former `browser_fill`, `browser_form_fill`, `browser_pick_date`, and
`browser_pick_option` tools are removed. Their per-tool dispatch and error
surfaces are replaced by the two semantic fill tools and the shared
`FILL_VALUE_INVALID`/`WIDGET_*` failure family.

### `browser_fill_form` — multi-field forms

`browser_fill_form` takes an ordered array of 1–10 `{ field, value }` entries,
where `value` is a non-secret string. Before every field it makes a fresh
uncapped internal observation and resolves `field` by current `eNN` ref or
visible name. The unified engine then routes the value through native select,
listbox, reactive suggestion, calendar grid, date input, toggle, or ordinary
text logic.

Values shaped as `YYYY-MM-DD` become date intents. Two ISO dates separated by
`..` become a range. `checked`/`unchecked` operate checkbox, radio, and switch
controls. Suggestions are discovered after typing, ranked without guessing,
and committed only on a unique best match.

Every applied item reports `{ field, ref, driver, committed?, dismissed, actions }`. The tool
stops on the first failure and attaches the successfully applied prefix. The old
`FORM_WIDGET_NO_MATCH` and `SUGGESTION_NOT_OFFERED` codes are retired; widget
failures use the shared `WIDGET_*` set with observed candidates, dates, or
committed value in `details`.

The tool never submits. Credential-shaped literals are refused before any field
is touched, and secret refs are outside this form schema. Use
`browser_fill_element` for a host-bound credential; it requires confirmation,
resolves the secret only at the execution boundary, skips suggestion/readback
logic, and never exposes the value in its result or trace. Activate the form's
submit/search control with `browser_click` after the returned observation.

### Saved-workflow `fill_element`

Promoted traces persist the same semantic operation as a canonical workflow
step. `field_name` is resolved from a fresh page scan on replay; `locator` is the
deterministic fallback candidate chain, and `value` accepts literals, direct
secret refs, or embedded param templates:

```yaml
- id: s2
  verb: fill_element
  field_name: Dates
  locator: Dates field
  value: '{{ param:from }}..{{ param:to }}'
  scope: null
  requires_confirmation: false
```

Replay resolves params and secrets through `ValueResolver`, drives the same core
engine, and returns typed `WIDGET_*` failures under the normal retry budget. No
LLM is consulted. Existing `fill` workflow steps remain valid and unchanged.

## Browser session and observation model

Agentic browser use is run-scoped and lazy: Chrome starts on the first
`browser_navigate`, owns one page, and always uses a fresh ephemeral profile.
The profile is removed during normal completion, abort, or browser teardown.
Persistent/logged-in profiles are intentionally out of scope for this release.
Popups and new tabs are closed instead of adopted — whether declared
(`target=_blank`, inline `window.open`) or opened by dynamically wired event
listeners. The popup is given a bounded moment to reach its real URL (not
`about:blank`), and that URL is returned as `popup_intercepted` so a later
explicit navigation re-enters URL and ethics policy. That navigation is
possible because every action result — `browser_navigate` and `browser_click`
alike — records both where it landed and any intercepted popup target as URL
provenance: the page produced those URLs, so they are attested, while a URL the
model assembles still is not. JS dialogs are
auto-handled so they can never deadlock the page: `beforeunload` is accepted
(agent-initiated navigation proceeds), alert/confirm/prompt are dismissed —
never silently accepted — and the message is returned as `dialog_intercepted`.

In-page overlays the _site_ raises are closed after a navigation, since the
caller asked for a page rather than a dialog: a rendered, floating
dialog/listbox/menu/grid is sent Escape (at most three presses, stopping the
moment one closes nothing) and the count is returned as `overlays_dismissed`.
This is what keeps a hotel site that serves its date picker already open from
filling the entire capped observation with day cells while the search form
stays invisible. Statically positioned content — results marked up as
`role="grid"` — is not an overlay and is never Escaped, and an overlay the
agent opened _itself_ by clicking is left alone: it may be the thing it means
to operate. Widgets the fill engine opens are released by the fill engine
(`packages/core/src/fill/dismiss.ts`).

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
`browser_navigate`, `browser_click`, `browser_fill_element`, and `browser_fill_form`
return an `observation`
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
widget/container, including a calendar month heading.

`name` is the accessible name, computed per accname rather than taken from the
element's text. Two rules do the work, and composite controls depend on both: a
descendant contributes its own declared label in place of its text, and an
`aria-hidden` subtree contributes nothing. A day cell built as
`<div role="button"><div aria-label="Sunday, September 6, 2026"></div><div aria-hidden="true">6</div></div>`
is therefore named for its date and not `6` — the name a two-month calendar
repeats across panels. Inline content is concatenated without an inserted
separator, matching browsers, so `Track<span>chevron_right</span>` stays one
token. Visible open dialogs,
listboxes, menus, and grids rank before page scope. Within a scope, labelled
groups are panel-major: groups are ordered by their first `(top, left)` position
and every member of one group is contiguous in `(top, left)` order before the
next group. Ungrouped page chrome retains its ordinary relative reading order.
Password, one-time-code, and payment-secret field contents
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
cannot be used by `browser_fill_element` until host metadata is added. The resolved
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
