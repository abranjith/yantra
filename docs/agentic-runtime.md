# Agentic runtime

`yantra ask`, `yantra research`, and `yantra do "<goal>"` use one fresh provider session and one Yantra run directory whenever LLM reasoning is enabled. The CLI is an input/output surface; the agent package owns the reasoning loop, command tool policy, budgets, publication requirement, and teardown.

The CLI never owns the reasoning loop. It parses the goal and flags, selects model/auth, constructs a connector, calls `runAgenticTask()`, and maps the closed outcome to an exit code. The runtime creates the run before provider validation, subscribes the stable event/audit projection, requires `result_publish`, and closes the browser, provider session, writers, manifest, and report on every terminal path.

## Prompt governance

The production system prompt lives in `packages/agent/src/runtime/prompt.ts`. It has exactly five governed sections: role, operating loop, trust boundary, safety, and completion/failure. Tool names, schemas, and provider mechanics are intentionally absent because the registered tool catalog is authoritative.

Every semantic prompt edit must also bump `PROMPT_VERSION`. Runs record both that version and a SHA-256 hash of the exact prompt text, so audits can distinguish prompt revisions. The per-run user prompt contains only the sanitized goal, enforced constraints, allowed hosts/scope, and bounded approved profile context; page content and tool results remain untrusted data.

## Command profiles and deterministic mode

`--no-llm` or `LLM_PROVIDER=none` selects the existing deterministic `ask` or `research` pipeline before Yantra constructs an agent session or contacts a model provider. Otherwise the command uses the same `runAgenticTask()` runtime and the same `result_publish` Brief validation used by `do`; run artifacts, usage, and `yantra audit` therefore have one format.

| Command | Default agent tools | Notes |
| --- | --- | --- |
| `ask` | `web_search`, `web_fetch`, `script_run`, `workflow_run` (list only), `result_publish` | Produces a cited answer Brief; it cannot browse or execute workflows. |
| `research` | `web_search`, `web_fetch`, `script_run`, `workflow_run`, `result_publish` | Requires broad multi-source evidence before publication. Set `YANTRA_AGENT_RESEARCH_BROWSE=1` to add read-only browser navigation, observation, and extraction; browser mutations remain unavailable. |
| `do` | Full registered catalog | Includes browser actions and deterministic workflow execution, still guarded by policy and confirmation. |

Command-budget defaults are configuration keys: `YANTRA_AGENT_ASK_*`, `YANTRA_AGENT_RESEARCH_*`, and `YANTRA_AGENT_DO_*` accept `BUDGET_MS`, `MAX_TOOL_CALLS`, and `MAX_CALLS_PER_TOOL` suffixes. The defaults intentionally increase from ask to research to do.

## Confirmation UX

Protected actions show the tool action, sanitized summary, host, expected cost (when known), and consequence before anything executes. The default answer is denial. An interactive wait is bounded by `agent.confirmation_wait_ms` and by the run's remaining wall-clock budget; the wall clock continues while the prompt is open.

Timeouts are recorded as `CONFIRMATION_TIMEOUT` and fail closed, so the agent may choose a safe alternative or hand off. `--json`, non-TTY, scheduled, and daemon surfaces never prompt and deny immediately. Ctrl+C or budget exhaustion cancels a pending prompt and enters the same full teardown path as any other run abort.

## Live output

Assistant text streams as progress. Tool lines show only the registered name, a bounded field-name summary, terminal status, and duration; raw tool parameters and results are never rendered. A successful terminal line points to the persisted Brief, while a handoff prints the blocker and safest next action.

With `--json`, every progress item and the final outcome is one independently parseable NDJSON line. JSON mode is non-interactive, so any protected action fails closed instead of producing a prompt that would corrupt the stream.

## Saved workflows: discovery and promotion

The runtime bridges to Yantra's deterministic workflow engine in both directions:

- **Discover and run** a saved workflow with the `workflow_run` tool. The agent chooses a saved workflow when one matches the goal; it replays deterministically (no LLM inside the workflow) in its own nested run directory, and the agent sees only a sanitized status/outputs summary — never the workflow's secrets or internal locators. See [agent-tools.md](agent-tools.md).
- **Promote** a successful ad-hoc browser run into a reusable workflow with `yantra do "<goal>" --save-as <name>`. On a published outcome, the run's `trace.json` (see [run-artifacts.md](run-artifacts.md)) is converted into a saved, lint-clean workflow with candidate-chain locators; secret fills become declared `{{ secret:key }}` references and confirmation flags are preserved. `yantra run <name>` then replays it with no model credentials. Promotion failure is reported but never fails the run.

## Release gate

`e2e/agent-do.spec.ts` is the cross-platform release gate for `yantra do`. Its no-LLM scenarios assert run artifacts for multi-page publication, verified form consent, CAPTCHA handoff, grant/denial/timeout/non-interactive confirmation, prompt-injection text in pages and search snippets, off-policy fetch refusal, and credential-shaped URL exfiltration controls. The opt-in `@requires-llm` case runs when `YANTRA_RUN_LIVE_AGENT_E2E=1`; the deterministic cases are mandatory on Windows, macOS, and Linux.

`e2e/agent-workflow-bridge.spec.ts` is the release gate for the workflow bridge: a real-Chrome promotion round-trip (a fake-agent navigate→fill→click→extract run promotes via `--save-as` to a workflow that `yantra run` replays green with `LLM_PROVIDER=none`) and an invocation path (an agent scripting `workflow_run` lists the catalog and runs a saved workflow whose nested run carries zero agent-session artifacts, joined to the parent by nested `run_id`).
