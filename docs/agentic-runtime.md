# Agentic runtime

`yantra ask`, `yantra research`, and `yantra do "<goal>"` use one fresh provider session and one Yantra run directory whenever LLM reasoning is enabled. The CLI is an input/output surface; the agent package owns the reasoning loop, command tool policy, budgets, publication requirement, and teardown.

The CLI never owns the reasoning loop. It parses the goal and flags, selects model/auth, constructs a connector, calls `runAgenticTask()`, and maps the closed outcome to an exit code. The runtime creates the run before provider validation, subscribes the stable event/audit projection, requires `result_publish`, and closes the browser, provider session, writers, manifest, and report on every terminal path.

## Prompt governance

The production system prompt lives in `packages/agent/src/runtime/prompt.ts`. It has exactly five governed sections: role, operating loop, trust boundary, safety, and completion/failure. Tool names, schemas, and provider mechanics are intentionally absent because the registered tool catalog is authoritative.

Every semantic prompt edit must also bump `PROMPT_VERSION` (currently `agent-v6`). Runs record both that version and a SHA-256 hash of the exact prompt text, so audits can distinguish prompt revisions. The per-run user prompt contains only the sanitized goal, an ambient context block, enforced constraints, allowed hosts/scope, and bounded approved profile context; page content and tool results remain untrusted data.

The ambient block states **every** ambient fact on every run. Current date, timezone, and locale come from the run clock and host environment and always render — framed as authoritative because small local models otherwise guess the date from their training prior. The user's location is personal data, so it renders only when the `context.location` grant permits it _and_ a value is configured; otherwise the block states `- user location: not available`. Naming the absence is the point: an omitted line reads as an oversight the model may fill in, while a stated absence plus the block's closing rule — never guess or derive a fact marked `not available` — reads as a boundary. The trust boundary reinforces it: the model may not infer the user's location from ambient signals such as the timezone.

The location value reaches the prompt only through `resolveUserLocation`, which reads approved preferences, sanitizes, caps at 120 characters, and returns a `Sanitized<string>` — the only type the ambient block's location slot accepts. See [personalization-and-privacy.md](personalization-and-privacy.md).

## Location pre-flight gate

Some goals cannot be answered without knowing where the user is. Before the provider session opens — no tokens spent, no browser launched — `runAgenticTask()` checks whether the goal is _self-referentially_ location-dependent (`near me`, `nearby`, `in my area`, `where I live`, and similar) while no location is available. When both hold, the run ends immediately as a **`handoff` (exit 4)**:

> **Blocker:** This goal needs your location, but none is available and Yantra will not infer one.

The remedy branches on what is actually wrong:

| Situation                               | `safestNextAction`                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Grant held, no value configured         | ``Set one with `yantra prefs set locale.city "<city, state>"`, or name the location in the query.``                         |
| Grant denied (`context.location false`) | ``Location sharing is off. Re-enable it with `yantra prefs set context.location true`, or name the location in the query.`` |

(The prompt deliberately does _not_ distinguish these two — see [personalization-and-privacy.md](personalization-and-privacy.md). The user-facing remedy does, because the user knows what they chose.)

The gate is intentionally conservative and matches only self-referential phrasings, so bare `nearest`/`closest` do not trigger it — "the nearest station to Times Square" carries its own anchor. This is a **two-layer design, not a gap**: anything the phrase list misses is still covered by the `not available` marker and the never-derive prompt rule, so such a goal ends in a model-reported blocker rather than a guessed city. The run directory, failure event, and `report.md` are written exactly as for any other handoff.

## Command profiles and deterministic mode

`--no-llm` or `LLM_PROVIDER=none` selects the existing deterministic `ask` or `research` pipeline before Yantra constructs an agent session or contacts a model provider. Otherwise the command uses the same `runAgenticTask()` runtime and the same `result_publish` Brief validation used by `do`; run artifacts, usage, and `yantra audit` therefore have one format.

| Command    | Default agent tools                                                                   | Notes                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask`      | `web_search`, `web_fetch`, `script_run`, `workflow_run` (list only), `result_publish` | Produces a cited answer Brief; it cannot browse or execute workflows.                                                                                                                                 |
| `research` | `web_search`, `web_fetch`, `script_run`, `workflow_run`, `result_publish`             | Requires broad multi-source evidence before publication. Set `YANTRA_AGENT_RESEARCH_BROWSE=1` to add read-only browser navigation, observation, and extraction; browser mutations remain unavailable. |
| `do`       | Full registered catalog                                                               | Includes browser actions and deterministic workflow execution, still guarded by policy and confirmation.                                                                                              |

Model, credential, budget, retry, confirmation, and deterministic selection are
uniform across `ask`, `research`, `do`, `run`, and `resume`. They are registered
and resolved from `apps/cli/src/agent-options.ts`, so commands cannot drift.
See the canonical [Agentic options](model-configuration.md#agentic-options)
table for flags, profile keys, environment variables, precedence, duration
syntax, and defaults.

Tool-call counts are audit data, not completion policy. Hard safety bounds remain
on provider tokens, result bytes, navigation count, host count, per-tool time,
confirmation waits, and the whole-run wall clock. At 80% of the wall clock,
exploration winds down: further non-terminal calls are refused while publication
remains available. This favors an honest partial Brief over losing gathered
evidence at the deadline.

## Confirmation UX

Protected actions show the tool action, sanitized summary, host, expected cost (when known), and consequence before anything executes. The default answer is denial. An interactive wait is bounded by `--confirm-timeout` (or its environment/profile equivalent) and by the run's remaining wall-clock budget; the wall clock continues while the prompt is open.

Timeouts are recorded as `CONFIRMATION_TIMEOUT` and fail closed, so the agent may choose a safe alternative or hand off. `--json`, non-TTY, scheduled, and daemon surfaces never prompt and deny immediately. Ctrl+C or budget exhaustion cancels a pending prompt and enters the same full teardown path as any other run abort.

## Live output

Assistant text streams as progress. Tool lines show only the registered name, a bounded field-name summary, terminal status, and duration; raw tool parameters and results are never rendered. A successful terminal line points to the persisted Brief, while a handoff prints the blocker and safest next action.

With `--json`, every progress item and the final outcome is one independently parseable NDJSON line. JSON mode is non-interactive, so any protected action fails closed instead of producing a prompt that would corrupt the stream.

## Saved workflows: discovery and promotion

The runtime bridges to Yantra's deterministic workflow engine in both directions:

- **Discover and run** a saved workflow with the `workflow_run` tool. The agent chooses a saved workflow when one matches the goal; it replays deterministically (no LLM inside the workflow) in its own nested run directory, and the agent sees only a sanitized status/outputs summary — never the workflow's secrets or internal locators. See [agent-tools.md](agent-tools.md).
- **Promote** a successful ad-hoc browser run into a reusable workflow with `yantra do "<goal>" --save-as <name>`. On a published outcome, the run's `trace.json` (see [run-artifacts.md](run-artifacts.md)) is converted into a saved, lint-clean workflow with candidate-chain locators; secret fills become declared `{{ secret:key }}` references and confirmation flags are preserved. The workflow also inherits the run's goal as a `synthesis:` block with `use_llm: true` — a model wrote that run's report — so `yantra run <name>` reproduces the Brief the original run published without being told to. Promotion failure is reported but never fails the run.

## LLM in replay

Replay is **finite, validated, and LLM-free unless the workflow says otherwise**.
A workflow's `synthesis.use_llm` lets a model write the run's output document,
and an `llm_summarize` step lets one transform a declared capture. Neither can
steer the run.

The decision lives in the **workflow**, not the invocation: `yantra run <name>`
takes no mode flag and reproduces whatever the workflow was saved to produce, the
way `ask` and `do` need no flag to do what they do. `yantra do --save-as` records
`use_llm: true` because a model authored that run's report; a hand-written
workflow leaves it false and never reaches a provider. `--no-llm` is a veto and
never an opt-in — it can turn a workflow's declaration off, never on.

> **The never-steers invariant.** An LLM may transform a declared capture or
> synthesize the run's output document. It may **never** influence step selection,
> branch conditions, loop bounds, or locator repair. The plan's shape is fixed and
> validated _before_ execution and cannot change based on model output.

This is what keeps the determinism guarantee intact rather than weakened: a
`synthesis:` block and an `llm_summarize` step are declared, validated **leaves**
of a finite plan. The same steps run in the same order with or without a model —
only the wording of the final document differs.

Two surfaces are **hard zero-LLM**, regardless of what the workflow declares:

| Surface                         | Behavior                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Scheduled / daemon runs**     | Never open a provider session. A workflow declaring `synthesis:` still gets a Brief — composed deterministically.             |
| **Nested `workflow_run` calls** | Replay deterministically inside the agent's run and write no Brief of their own; the nested run dir has no session artifacts. |

Supporting guarantees:

- **Best-effort throughout.** A provider failure, an adapter that cannot be
  constructed at all, model output that never validates, or an unwritable
  artifact degrades to the deterministic Brief or to no Brief, logging a warning
  and recording `fallbackUsed` in `manifest.synthesis`. Synthesis never turns a
  successful run into a failed one, and exit codes are unchanged.
- **Validation stays validation.** An invalid `--provider`/`--model` is resolved
  before execution begins, so it exits 1 rather than failing a started run.
- **`llm_summarize` passes through** when no model is configured, binding its raw
  input to `output_as` and publishing an `llm_step_skipped` event. A workflow
  containing one therefore stays runnable _and_ schedulable without a model.
- **Sanitized before send.** Every payload reaching the model passes the
  sanitizer at the workflow's `security_class` profile, enforced by the
  `scripts/ci-static-check.ts` sanitize-before-send guard.
- **Resume inherits the strategy.** A resumed run reproduces its Brief the way
  the first attempt did, read from `manifest.synthesis`. A run that _wanted_ a
  model and had to fall back (`fallbackUsed: true`) is offered one again, so a
  single transient provider failure does not permanently downgrade a workflow.

## Release gate

`e2e/agent-do.spec.ts` is the cross-platform release gate for `yantra do`. Its no-LLM scenarios assert run artifacts for multi-page publication, verified form consent, CAPTCHA handoff, grant/denial/timeout/non-interactive confirmation, prompt-injection text in pages and search snippets, off-policy fetch refusal, and credential-shaped URL exfiltration controls. The opt-in `@requires-llm` case runs when `YANTRA_RUN_LIVE_AGENT_E2E=1`; the deterministic cases are mandatory on Windows, macOS, and Linux.

`e2e/agent-workflow-bridge.spec.ts` is the release gate for the workflow bridge: a real-Chrome promotion round-trip (a fake-agent navigate→fill→click→extract run promotes via `--save-as` to a workflow that `yantra run` replays green with `LLM_PROVIDER=none`) and an invocation path (an agent scripting `workflow_run` lists the catalog and runs a saved workflow whose nested run carries zero agent-session artifacts, joined to the parent by nested `run_id`).
