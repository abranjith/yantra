# Protocol Spec

> DO NOT EDIT - regenerated from packages/protocol

Current schema version: **0.2**. Accepted versions: 0.1, 0.2.
The 0.2 bump is additive: it introduces the Brief document type; Plan and workflow contracts are unchanged and 0.1 documents remain valid.

## AgentManifestSection

Stable agent metadata embedded in manifest.json for one run-local session.

| Field             | Description                                                            |
| ----------------- | ---------------------------------------------------------------------- |
| adapter           | Agent adapter used for this run.                                       |
| sdk_version       | Installed provider SDK version resolved at runtime.                    |
| provider          | Effective model provider identifier.                                   |
| model             | Effective provider-scoped model identifier.                            |
| thinking          | Effective model thinking or reasoning level.                           |
| auth_source       | Credential source used to open the session; never credential material. |
| session_id        | Provider-assigned session identifier.                                  |
| session_file      | Relative path from the run directory to the provider session JSONL.    |
| prompt_version    | Version of the authoritative agent prompt.                             |
| prompt_hash       | SHA-256 of the exact system prompt.                                    |
| tool_catalog_hash | SHA-256 of the canonical tool catalog serialization.                   |

Example:

```json
{
  "adapter": "<adapter>",
  "sdk_version": "<sdk_version>",
  "provider": "<provider>",
  "model": "<model>",
  "thinking": "<thinking>",
  "auth_source": "<auth_source>",
  "session_id": "<session_id>",
  "session_file": "<session_file>",
  "prompt_version": "<prompt_version>",
  "prompt_hash": "<prompt_hash>",
  "tool_catalog_hash": "<tool_catalog_hash>"
}
```

## AgentUsageTotals

Aggregated provider usage for an agentic run.

| Field         | Description                                                          |
| ------------- | -------------------------------------------------------------------- |
| turns         | Completed provider turns.                                            |
| input_tokens  | Agent input tokens, or null when the provider does not report them.  |
| output_tokens | Agent output tokens, or null when the provider does not report them. |
| cost_usd      | Agent cost in USD, or null when the provider does not report it.     |

Example:

```json
{
  "turns": "<turns>",
  "input_tokens": "<input_tokens>",
  "output_tokens": "<output_tokens>",
  "cost_usd": "<cost_usd>"
}
```

## AssertCondition

Assertion condition payload.

Example:

```json
"<value>"
```

## AssertStep

Assert state against the current page.

| Field                 | Description                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| id                    | Step identifier, unique within the plan.                                                                                  |
| scope                 | Step scope; null inherits the plan default.                                                                               |
| requires_confirmation | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, and navigate steps. |
| type                  | Assert step discriminator.                                                                                                |
| locator               | Locator chain for assertion target.                                                                                       |
| condition             | Assertion condition payload.                                                                                              |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
  "requires_confirmation": "<requires_confirmation>",
  "type": "<type>",
  "locator": "<locator>",
  "condition": "<condition>"
}
```

## BranchCondition

Branch condition expression.

Example:

```json
"<value>"
```

## BranchStep

Explicit branch to another step id.

| Field                 | Description                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| id                    | Step identifier, unique within the plan.                                                                                  |
| scope                 | Step scope; null inherits the plan default.                                                                               |
| requires_confirmation | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, and navigate steps. |
| type                  | Branch step discriminator.                                                                                                |
| condition             | Branch condition payload.                                                                                                 |
| then_step_id          | Step id for true branch.                                                                                                  |
| else_step_id          | Optional step id for false branch.                                                                                        |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
  "requires_confirmation": "<requires_confirmation>",
  "type": "<type>",
  "condition": "<condition>",
  "then_step_id": "<then_step_id>",
  "else_step_id": "<else_step_id>"
}
```

## Brief

The universal synthesized output document: answer-first overview, key findings, sections, facets, numbered sources, notices, and metadata. Every citation resolves to a declared source (no uncited claims).

| Field          | Description                                                                 |
| -------------- | --------------------------------------------------------------------------- |
| brief_id       | Unique Brief document id (ULID).                                            |
| task_id        | Originating task id (ULID).                                                 |
| schema_version | Protocol schema version this document was written under.                    |
| title          | One-line document title.                                                    |
| overview       | Answer-first Markdown synthesis (1-3 paragraphs) with inline [n] citations. |
| key_findings   | Scannable findings; may be empty.                                           |
| sections       | Deep-detail sections; empty at the overview synthesis budget.               |
| facets         | Structured/tabular facets, or null when the query has no comparative shape. |
| sources        | Numbered, deduplicated source references.                                   |
| metadata       | Provenance and quality signals.                                             |
| notices        | Honest per-source failures and validator flags; may be empty.               |

Example:

```json
{
  "brief_id": "<brief_id>",
  "task_id": "<task_id>",
  "schema_version": "<schema_version>",
  "title": "<title>",
  "overview": "<overview>",
  "key_findings": "<key_findings>",
  "sections": "<sections>",
  "facets": "<facets>",
  "sources": "<sources>",
  "metadata": "<metadata>",
  "notices": "<notices>"
}
```

## BriefFacets

Structured/tabular facets of the Brief.

| Field      | Description                                                               |
| ---------- | ------------------------------------------------------------------------- |
| comparison | Tabular comparison data, or null when the query has no comparative shape. |

Example:

```json
{
  "comparison": "<comparison>"
}
```

## BriefMetadata

Provenance and quality metadata for the Brief.

| Field                       | Description                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| search_provider             | Search provider that produced the source candidates, or null.                                                                        |
| synthesis                   | Synthesis strategy that produced the Brief.                                                                                          |
| deterministic_fallback_used | True when the LLM path failed and the deterministic synthesizer took over.                                                           |
| coverage                    | Fraction of fetched sources represented in the Brief (0-1), or null.                                                                 |
| freshness                   | Human-readable freshness signal (for example "today"), or null.                                                                      |
| citation_verdict            | Citation-faithfulness verdict (filled post-synthesis), or null before validation.                                                    |
| usage                       | LLM usage totals, or null on the deterministic path.                                                                                 |
| evidence                    | Evidence-selection counts from the deterministic pipeline (candidate vs accepted claims, excluded sources), or null on the LLM path. |
| run_id                      | Owning run id, or null outside a run context.                                                                                        |

Example:

```json
{
  "search_provider": "<search_provider>",
  "synthesis": "<synthesis>",
  "deterministic_fallback_used": "<deterministic_fallback_used>",
  "coverage": "<coverage>",
  "freshness": "<freshness>",
  "citation_verdict": "<citation_verdict>",
  "usage": "<usage>",
  "evidence": "<evidence>",
  "run_id": "<run_id>"
}
```

## BriefNotice

An honest per-source failure or validator flag.

| Field  | Description                                                                                                                                                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| source | Host or subsystem the notice concerns.                                                                                                                                                                                                              |
| reason | Human-readable reason for the notice.                                                                                                                                                                                                               |
| kind   | Notice classification. `source_excluded` marks a source dropped as irrelevant to the query before assembly; `limited_evidence` marks a Brief that fell short of the requested length because too few relevant findings survived the evidence gates. |

Example:

```json
{
  "source": "<source>",
  "reason": "<reason>",
  "kind": "<kind>"
}
```

## BriefSource

A numbered, deduplicated source reference.

| Field        | Description                                                               |
| ------------ | ------------------------------------------------------------------------- |
| n            | Citation number; contiguous 1..N in array order.                          |
| url          | URL as fetched.                                                           |
| final_url    | Post-redirect landing URL, or null when no redirect was observed.         |
| host         | Source host.                                                              |
| title        | Page title, or null when unavailable.                                     |
| excerpt      | Short extracted snippet of the source content, or null when not captured. |
| fetched_at   | ISO-8601 UTC fetch timestamp.                                             |
| published_at | ISO-8601 publication timestamp, or null when unknown.                     |

Example:

```json
{
  "n": "<n>",
  "url": "<url>",
  "final_url": "<final_url>",
  "host": "<host>",
  "title": "<title>",
  "excerpt": "<excerpt>",
  "fetched_at": "<fetched_at>",
  "published_at": "<published_at>"
}
```

## BudgetSchema

Execution budget constraints.

| Field     | Description                 |
| --------- | --------------------------- |
| llm_calls | Optional max LLM calls.     |
| fetches   | Optional max fetch actions. |

Example:

```json
{
  "llm_calls": "<llm_calls>",
  "fetches": "<fetches>"
}
```

## BudgetSnapshot

Budget snapshot after a cycle.

| Field          | Description                |
| -------------- | -------------------------- |
| steps_used     | Steps consumed so far.     |
| llm_calls_used | LLM calls consumed so far. |
| wall_clock_ms  | Wall clock elapsed in ms.  |
| cost_usd       | Cost consumed in USD.      |

Example:

```json
{
  "steps_used": "<steps_used>",
  "llm_calls_used": "<llm_calls_used>",
  "wall_clock_ms": "<wall_clock_ms>",
  "cost_usd": "<cost_usd>"
}
```

## CallWorkflowStep

Invoke another workflow from the current plan.

| Field                 | Description                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| id                    | Step identifier, unique within the plan.                                                                                  |
| scope                 | Step scope; null inherits the plan default.                                                                               |
| requires_confirmation | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, and navigate steps. |
| type                  | Call-workflow step discriminator.                                                                                         |
| workflow_name         | Name of workflow to invoke.                                                                                               |
| params                | Param values passed to called workflow.                                                                                   |
| capture_as            | Optional capture alias for workflow output.                                                                               |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
  "requires_confirmation": "<requires_confirmation>",
  "type": "<type>",
  "workflow_name": "<workflow_name>",
  "params": "<params>",
  "capture_as": "<capture_as>"
}
```

## CaptureRef

Reference to values captured by a previous extract step.

| Field   | Description                                                         |
| ------- | ------------------------------------------------------------------- |
| kind    | Discriminator for capture references.                               |
| step_id | Extract step id that produced the capture.                          |
| field   | Optional extracted field key. Null means the whole capture payload. |

Example:

```json
{
  "kind": "<kind>",
  "step_id": "<step_id>",
  "field": "<field>"
}
```

## CapturedActionSchema

One captured user action during recording

Example:

```json
"<value>"
```

## ChildFinding

A one-level nested finding under a key finding.

| Field     | Description                                                                        |
| --------- | ---------------------------------------------------------------------------------- |
| text      | Markdown text of a nested child finding.                                           |
| citations | Source numbers (sources[].n) backing this child finding; at least one is required. |

Example:

```json
{
  "text": "<text>",
  "citations": "<citations>"
}
```

## ClickActionSchema

A user click event

| Field              | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| kind               |                                                                    |
| element_descriptor | Sanitized structural fingerprint of a captured DOM element         |
| candidate_chain    | Top-5 ranked locator candidates                                    |
| ts                 | ISO-8601 timestamp (page clock via performance.now() + timeOrigin) |
| url_before         | Page URL at the time of the action                                 |
| url_after          | Page URL after the action, null if no navigation within 500ms      |

Example:

```json
{
  "kind": "<kind>",
  "element_descriptor": "<element_descriptor>",
  "candidate_chain": "<candidate_chain>",
  "ts": "<ts>",
  "url_before": "<url_before>",
  "url_after": "<url_after>"
}
```

## ClickModifiers

Optional keyboard modifiers for click steps.

| Field | Description           |
| ----- | --------------------- |
| alt   | Alt modifier key.     |
| shift | Shift modifier key.   |
| ctrl  | Control modifier key. |
| meta  | Meta modifier key.    |

Example:

```json
{
  "alt": "<alt>",
  "shift": "<shift>",
  "ctrl": "<ctrl>",
  "meta": "<meta>"
}
```

## ClickStep

Click on a resolved locator target.

| Field                    | Description                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| id                       | Step identifier, unique within the plan.                                                                                  |
| scope                    | Step scope; null inherits the plan default.                                                                               |
| requires_confirmation    | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, and navigate steps. |
| confirmation_description | Human-readable override for the consent card. Falls back to step name when null.                                          |
| expected_cost            | Best-effort cost estimate shown on the consent card, or null if unknown.                                                  |
| consequence              | Reversibility hint for the action, or null to default to "unknown".                                                       |
| type                     | Click step discriminator.                                                                                                 |
| locator                  | Locator chain for click target.                                                                                           |
| modifiers                | Optional click modifier keys.                                                                                             |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
  "requires_confirmation": "<requires_confirmation>",
  "confirmation_description": "<confirmation_description>",
  "expected_cost": "<expected_cost>",
  "consequence": "<consequence>",
  "type": "<type>",
  "locator": "<locator>",
  "modifiers": "<modifiers>"
}
```

## ConfirmationDecidedBy

Who or what resolved the confirmation — no agent variant exists.

Example:

```json
"user_interactive"
```

## ConfirmationDecision

Terminal resolution of a ConfirmationRequest — always human-originated.

| Field           | Description                                        |
| --------------- | -------------------------------------------------- |
| confirmation_id | ULID of the request being resolved.                |
| decision        | Outcome: granted proceeds, denied/timed_out abort. |
| decided_at      | ISO-8601 UTC timestamp of the decision.            |
| decided_by      | Provenance of the decision — never agent.          |

Example:

```json
{
  "confirmation_id": "<confirmation_id>",
  "decision": "<decision>",
  "decided_at": "<decided_at>",
  "decided_by": "<decided_by>"
}
```

## ConfirmationRequest

Structured consent request emitted before a flagged step executes.

| Field           | Description                                                                |
| --------------- | -------------------------------------------------------------------------- |
| confirmation_id | Globally unique ULID for this confirmation request.                        |
| run_id          | Owning run id.                                                             |
| step_id         | Step id that triggered the request.                                        |
| action_kind     | The mutating verb that will execute on grant.                              |
| host            | Resolved target host for the action (e.g. "bank.example.com").             |
| description     | Human-readable summary of what will happen — from step name or annotation. |
| expected_cost   | Best-effort cost estimate, or null if unknown.                             |
| consequence     | Reversibility classification.                                              |
| requested_at    | ISO-8601 UTC timestamp when the request was created.                       |
| timeout_ms      | Timeout in milliseconds, or null to wait indefinitely (interactive mode).  |

Example:

```json
{
  "confirmation_id": "<confirmation_id>",
  "run_id": "<run_id>",
  "step_id": "<step_id>",
  "action_kind": "<action_kind>",
  "host": "<host>",
  "description": "<description>",
  "expected_cost": "<expected_cost>",
  "consequence": "<consequence>",
  "requested_at": "<requested_at>",
  "timeout_ms": "<timeout_ms>"
}
```

## ConsequenceLevel

How difficult it would be to undo the action if it goes wrong.

Example:

```json
"reversible"
```

## DiscoveryBudget

Hard budget caps for a discovery session.

| Field             | Description                                         |
| ----------------- | --------------------------------------------------- |
| max_steps         | Maximum total cycle steps before budget exhaustion. |
| max_llm_calls     | Maximum LLM propose calls before budget exhaustion. |
| max_wall_clock_ms | Wall-clock budget in milliseconds.                  |
| max_cost_usd      | Cost cap in USD, or null for no cost limit.         |

Example:

```json
{
  "max_steps": "<max_steps>",
  "max_llm_calls": "<max_llm_calls>",
  "max_wall_clock_ms": "<max_wall_clock_ms>",
  "max_cost_usd": "<max_cost_usd>"
}
```

## DiscoveryCycle

One propose → act → observe turn in a discovery session.

| Field        | Description                                                                  |
| ------------ | ---------------------------------------------------------------------------- |
| index        | 0-based cycle index.                                                         |
| proposal     | The (possibly normalized) proposal for this cycle.                           |
| validation   | Validation verdict for the proposal.                                         |
| observation  | Post-cycle observation, or null if the cycle was rejected without execution. |
| budget_after | Budget snapshot after this cycle.                                            |

Example:

```json
{
  "index": "<index>",
  "proposal": "<proposal>",
  "validation": "<validation>",
  "observation": "<observation>",
  "budget_after": "<budget_after>"
}
```

## DiscoveryDone

Terminal claim — triggers Brief assembly when goal_met is true.

| Field          | Description                                                     |
| -------------- | --------------------------------------------------------------- |
| goal_met       | Whether the agent believes the goal has been achieved.          |
| summary_md     | Markdown summary of what was found or accomplished.             |
| citations_hint | URLs of pages actually visited that support the summary claims. |

Example:

```json
{
  "goal_met": "<goal_met>",
  "summary_md": "<summary_md>",
  "citations_hint": "<citations_hint>"
}
```

## DiscoveryObservation

Post-sanitizer observation of the current page state, sent to the model.

| Field          | Description                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------- |
| url            | Current page URL after cycle execution.                                                            |
| title          | Page title or null if unavailable.                                                                 |
| page_digest    | Sanitized + truncated extract of readable page content.                                            |
| interactables  | Visible, enabled interactable elements (cap 30, ranked by prominence).                             |
| step_outcome   | Typed outcome of the cycle execution.                                                              |
| outcome_reason | Human-readable reason for the outcome (e.g. ethics rule, error message). Null on clean completion. |

Example:

```json
{
  "url": "<url>",
  "title": "<title>",
  "page_digest": "<page_digest>",
  "interactables": "<interactables>",
  "step_outcome": "<step_outcome>",
  "outcome_reason": "<outcome_reason>"
}
```

## DiscoveryOutcome

Terminal outcome of a discovery session.

Example:

```json
"goal_met"
```

## DiscoveryProposal

Untrusted LLM proposal for one discovery cycle.

| Field     | Description                                                        |
| --------- | ------------------------------------------------------------------ |
| rationale | Model's stated reasoning for this cycle — audited, never executed. |
| steps     | 1–3 standard protocol steps to execute this cycle.                 |
| done      | Terminal claim, or null if the goal is not yet met.                |

Example:

```json
{
  "rationale": "<rationale>",
  "steps": "<steps>",
  "done": "<done>"
}
```

## DiscoverySession

A complete bounded discovery session.

| Field             | Description                                                    |
| ----------------- | -------------------------------------------------------------- |
| session_id        | Globally unique ULID for this discovery session.               |
| run_id            | Owning run id.                                                 |
| goal              | The user-supplied goal string.                                 |
| budget            | Hard budget caps.                                              |
| host_allowlist    | Allowed hosts — navigation outside this set is blocked.        |
| cycles            | Ordered cycle history.                                         |
| outcome           | Terminal outcome.                                              |
| promoted_workflow | Workflow name if the path was promoted via --save-as, or null. |

Example:

```json
{
  "session_id": "<session_id>",
  "run_id": "<run_id>",
  "goal": "<goal>",
  "budget": "<budget>",
  "host_allowlist": "<host_allowlist>",
  "cycles": "<cycles>",
  "outcome": "<outcome>",
  "promoted_workflow": "<promoted_workflow>"
}
```

## DiscoveryStepOutcome

Typed outcome of the executed cycle steps.

Example:

```json
"completed"
```

## DiscoveryValidation

Validation outcome for a discovery proposal.

| Field   | Description                              |
| ------- | ---------------------------------------- |
| verdict | Whether the proposal passed validation.  |
| reasons | Rejection reasons (empty when accepted). |

Example:

```json
{
  "verdict": "<verdict>",
  "reasons": "<reasons>"
}
```

## ElementDescriptorSchema

Sanitized structural fingerprint of a captured DOM element

| Field           | Description                                                                      |
| --------------- | -------------------------------------------------------------------------------- |
| tag             | Lowercase tag name, e.g. "button"                                                |
| role            | ARIA computed role, or null if not applicable                                    |
| accessible_name | ARIA accessible name, truncated to 200 chars                                     |
| visible_text    | innerText truncated to 200 chars with normalized whitespace                      |
| attrs_sample    | Sampled subset of element attributes — only whitelisted keys, max 100 chars each |
| bounding_rect   | Element bounding rectangle in page coordinates                                   |
| in_iframe       | True if the element lives inside an iframe                                       |
| xpath_for_debug | Absolute XPath, shown only with --debug, never used for replay                   |

Example:

```json
{
  "tag": "<tag>",
  "role": "<role>",
  "accessible_name": "<accessible_name>",
  "visible_text": "<visible_text>",
  "attrs_sample": "<attrs_sample>",
  "bounding_rect": "<bounding_rect>",
  "in_iframe": "<in_iframe>",
  "xpath_for_debug": "<xpath_for_debug>"
}
```

## ExpectedCost

Best-effort cost estimate for the action being confirmed.

| Field    | Description                                                          |
| -------- | -------------------------------------------------------------------- |
| amount   | Numeric cost amount.                                                 |
| currency | ISO 4217 currency code or descriptive label (e.g. "USD", "credits"). |

Example:

```json
{
  "amount": "<amount>",
  "currency": "<currency>"
}
```

## ExtractStep

Extract data from the page using a declared schema.

| Field                 | Description                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| id                    | Step identifier, unique within the plan.                                                                                  |
| scope                 | Step scope; null inherits the plan default.                                                                               |
| requires_confirmation | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, and navigate steps. |
| type                  | Extract step discriminator.                                                                                               |
| locator               | Locator chain for extraction target.                                                                                      |
| extraction_schema     | Expected extracted data shape.                                                                                            |
| capture_as            | Capture alias for downstream references.                                                                                  |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
  "requires_confirmation": "<requires_confirmation>",
  "type": "<type>",
  "locator": "<locator>",
  "extraction_schema": "<extraction_schema>",
  "capture_as": "<capture_as>"
}
```

## ExtractionErrorRow

Row-level extraction error envelope.

| Field     | Description                                 |
| --------- | ------------------------------------------- |
| \_\_error | Coercion failure reason for this row.       |
| \_\_raw   | Original raw row payload prior to coercion. |

Example:

```json
{
  "__error": "<__error>",
  "__raw": "<__raw>"
}
```

## ExtractionResultEnvelopeUnknown

Lenient-with-evidence extraction envelope.

| Field    | Description                                      |
| -------- | ------------------------------------------------ |
| rows     | Extracted rows including per-row error evidence. |
| metadata | Extraction aggregate metadata.                   |

Example:

```json
{
  "rows": "<rows>",
  "metadata": "<metadata>"
}
```

## ExtractionSchema

No description provided.

Example:

```json
"<value>"
```

## FailureClass

Failure category emitted in task_failed and retry events.

Example:

```json
"locator_not_found"
```

## FillActionSchema

A form fill event — value is always redacted

| Field              | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| kind               |                                                                    |
| element_descriptor | Sanitized structural fingerprint of a captured DOM element         |
| candidate_chain    | Top-5 ranked locator candidates                                    |
| ts                 | ISO-8601 timestamp (page clock via performance.now() + timeOrigin) |
| url_before         | Page URL at the time of the action                                 |
| url_after          | Page URL after the action, null if no navigation within 500ms      |
| raw_value          | Always the literal string "<redacted>" — type system enforces this |
| value_length       | Number of code points the user typed (not PII)                     |
| input_type         | Input type from the DOM — purely structural, no value content      |

Example:

```json
{
  "kind": "<kind>",
  "element_descriptor": "<element_descriptor>",
  "candidate_chain": "<candidate_chain>",
  "ts": "<ts>",
  "url_before": "<url_before>",
  "url_after": "<url_after>",
  "raw_value": "<raw_value>",
  "value_length": "<value_length>",
  "input_type": "<input_type>"
}
```

## FillStep

Fill an input-like field.

| Field                    | Description                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| id                       | Step identifier, unique within the plan.                                                                                  |
| scope                    | Step scope; null inherits the plan default.                                                                               |
| requires_confirmation    | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, and navigate steps. |
| confirmation_description | Human-readable override for the consent card. Falls back to step name when null.                                          |
| expected_cost            | Best-effort cost estimate shown on the consent card, or null if unknown.                                                  |
| consequence              | Reversibility hint for the action, or null to default to "unknown".                                                       |
| type                     | Fill step discriminator.                                                                                                  |
| locator                  | Locator chain for fill target.                                                                                            |
| value                    | Value inserted into the target input.                                                                                     |
| submit                   | Whether to submit after filling.                                                                                          |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
  "requires_confirmation": "<requires_confirmation>",
  "confirmation_description": "<confirmation_description>",
  "expected_cost": "<expected_cost>",
  "consequence": "<consequence>",
  "type": "<type>",
  "locator": "<locator>",
  "value": "<value>",
  "submit": "<submit>"
}
```

## HandoffReason

Reason human intervention is required.

Example:

```json
"captcha"
```

## InputTypeHintSchema

Input type from the DOM — purely structural, no value content

Example:

```json
"text"
```

## InteractableDescriptor

Sanitized descriptor of one interactable element on the page.

| Field    | Description                                                        |
| -------- | ------------------------------------------------------------------ |
| role     | ARIA role or semantic kind (e.g. "button", "link", "textbox").     |
| name     | Accessible name or label, truncated to 200 chars. Null if unnamed. |
| kind     | Coarse interaction kind for the model to reason about.             |
| disabled | Whether the element is disabled or aria-disabled.                  |

Example:

```json
{
  "role": "<role>",
  "name": "<name>",
  "kind": "<kind>",
  "disabled": "<disabled>"
}
```

## KeyFinding

A scannable, citation-backed finding bullet.

| Field     | Description                                                                                                                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text      | Markdown text of the finding. Inline [n] markers are optional: the LLM path may emit them, while the deterministic path carries citations only in the structured citations[] array. The structured array is the single source of truth for rendering. |
| citations | Source numbers (sources[].n) backing this finding. At least one is required unless editorial is true.                                                                                                                                                 |
| editorial | True marks uncited synthesis commentary — the only legal uncited form.                                                                                                                                                                                |
| facet     | Optional structured payload (for example { price: 328, in_stock: true }), or null.                                                                                                                                                                    |
| children  | Nested child findings that elaborate this parent; one level deep only.                                                                                                                                                                                |

Example:

```json
{
  "text": "<text>",
  "citations": "<citations>",
  "editorial": "<editorial>",
  "facet": "<facet>",
  "children": "<children>"
}
```

## LLMSummarizeStep

Summarize extracted captures with an LLM.

| Field                 | Description                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| id                    | Step identifier, unique within the plan.                                                                                  |
| scope                 | Step scope; null inherits the plan default.                                                                               |
| requires_confirmation | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, and navigate steps. |
| type                  | LLM summarize step discriminator.                                                                                         |
| input                 | Capture reference fed to summarization.                                                                                   |
| prompt                | Summarization instruction prompt.                                                                                         |
| output_as             | Capture alias for summarization output.                                                                                   |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
  "requires_confirmation": "<requires_confirmation>",
  "type": "<type>",
  "input": "<input>",
  "prompt": "<prompt>",
  "output_as": "<output_as>"
}
```

## LiteralValue

Literal scalar value.

| Field | Description                                |
| ----- | ------------------------------------------ |
| kind  | Discriminator for literal values.          |
| value | Literal scalar value embedded in the plan. |

Example:

```json
{
  "kind": "<kind>",
  "value": "<value>"
}
```

## LocatorCandidate

Candidate locator entry in workflow \_locators block.

Example:

```json
"<value>"
```

## LocatorChain

No description provided.

Example:

```json
"<value>"
```

## LoopStep

Iterate over collection values.

| Field                 | Description                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| id                    | Step identifier, unique within the plan.                                                                                  |
| scope                 | Step scope; null inherits the plan default.                                                                               |
| requires_confirmation | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, and navigate steps. |
| type                  | Loop step discriminator.                                                                                                  |
| over                  | Collection reference iterated by loop.                                                                                    |
| as                    | Loop variable alias.                                                                                                      |
| body_step_ids         | Step ids that form the loop body.                                                                                         |
| max_iterations        | Hard cap for loop iterations at runtime.                                                                                  |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
  "requires_confirmation": "<requires_confirmation>",
  "type": "<type>",
  "over": "<over>",
  "as": "<as>",
  "body_step_ids": "<body_step_ids>",
  "max_iterations": "<max_iterations>"
}
```

## NameMatch

Accessible-name matcher for intent locators.

Example:

```json
"<value>"
```

## NavigateActionSchema

A page navigation event

| Field                     | Description                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| kind                      |                                                                                          |
| ts                        |                                                                                          |
| url_before                |                                                                                          |
| url_after                 |                                                                                          |
| navigation_kind           | How the navigation was triggered                                                         |
| triggered_by_action_index | Index of the click action that triggered this navigation, null for non-click navigations |

Example:

```json
{
  "kind": "<kind>",
  "ts": "<ts>",
  "url_before": "<url_before>",
  "url_after": "<url_after>",
  "navigation_kind": "<navigation_kind>",
  "triggered_by_action_index": "<triggered_by_action_index>"
}
```

## NavigateStep

Navigate browser to a URL.

| Field                    | Description                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| id                       | Step identifier, unique within the plan.                                                                                  |
| scope                    | Step scope; null inherits the plan default.                                                                               |
| requires_confirmation    | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, and navigate steps. |
| confirmation_description | Human-readable override for the consent card. Falls back to step name when null.                                          |
| expected_cost            | Best-effort cost estimate shown on the consent card, or null if unknown.                                                  |
| consequence              | Reversibility hint for the action, or null to default to "unknown".                                                       |
| type                     | Navigate step discriminator.                                                                                              |
| url                      | Target URL as a value reference.                                                                                          |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
  "requires_confirmation": "<requires_confirmation>",
  "confirmation_description": "<confirmation_description>",
  "expected_cost": "<expected_cost>",
  "consequence": "<consequence>",
  "type": "<type>",
  "url": "<url>"
}
```

## OutputBinding

Named output mapping from a capture reference.

| Field | Description                                |
| ----- | ------------------------------------------ |
| name  | Output binding name.                       |
| from  | Capture reference used to populate output. |

Example:

```json
{
  "name": "<name>",
  "from": "<from>"
}
```

## ParamDeclaration

Workflow parameter declaration.

| Field    | Description                    |
| -------- | ------------------------------ |
| type     | Declared param scalar type.    |
| example  | Optional example value.        |
| required | Whether the param is required. |

Example:

```json
{
  "type": "<type>",
  "example": "<example>",
  "required": "<required>"
}
```

## ParamRef

Reference to runtime input provided by the user.

| Field | Description                                 |
| ----- | ------------------------------------------- |
| kind  | Discriminator for runtime param references. |
| key   | Declared workflow/task param key.           |

Example:

```json
{
  "kind": "<kind>",
  "key": "<key>"
}
```

## PlanSchema

Validated execution plan produced by the agent.

| Field          | Description                                                                     |
| -------------- | ------------------------------------------------------------------------------- |
| task_id        | Owning task id.                                                                 |
| plan_id        | Unique plan id.                                                                 |
| schema_version | Protocol schema version the plan was authored under; legacy 0.1 stays accepted. |
| default_scope  | Default scope applied when step scope is null.                                  |
| steps          | Ordered finite list of plan steps.                                              |
| outputs        | Optional plan outputs.                                                          |

Example:

```json
{
  "task_id": "<task_id>",
  "plan_id": "<plan_id>",
  "schema_version": "<schema_version>",
  "default_scope": "<default_scope>",
  "steps": "<steps>",
  "outputs": "<outputs>"
}
```

## RankedCandidateSchema

One entry in the ranked locator candidate chain

| Field       | Description                                                          |
| ----------- | -------------------------------------------------------------------- |
| candidate   | The locator intent for this candidate                                |
| score       | Ranking score from 0..1 (may be slightly > 1 for boosted candidates) |
| rank_reason | Short human label explaining the score                               |

Example:

```json
{
  "candidate": "<candidate>",
  "score": "<score>",
  "rank_reason": "<rank_reason>"
}
```

## RecordingDraftSchema

The complete recording draft artifact produced by the recorder (FEAT-008)

| Field              | Description                                                                |
| ------------------ | -------------------------------------------------------------------------- |
| schema_version     | Schema version for forward-compatibility checks                            |
| recording_id       | ULID-formatted recording identifier                                        |
| workflow_name_hint | Workflow name hint from RecordingSession.start()                           |
| started_at         | ISO-8601 session start timestamp                                           |
| stopped_at         | ISO-8601 session stop timestamp                                            |
| stop_reason        | Reason the recording ended                                                 |
| actions            | Ordered list of captured actions                                           |
| metadata           | Session-level metadata written to metadata.json and embedded in draft.json |

Example:

```json
{
  "schema_version": "<schema_version>",
  "recording_id": "<recording_id>",
  "workflow_name_hint": "<workflow_name_hint>",
  "started_at": "<started_at>",
  "stopped_at": "<stopped_at>",
  "stop_reason": "<stop_reason>",
  "actions": "<actions>",
  "metadata": "<metadata>"
}
```

## RecordingMetadataSchema

Session-level metadata written to metadata.json and embedded in draft.json

| Field                    | Description                                                               |
| ------------------------ | ------------------------------------------------------------------------- |
| start_ts                 | ISO-8601 recording start timestamp                                        |
| end_ts                   | ISO-8601 recording end timestamp, null until stop/abort                   |
| os                       |                                                                           |
| chrome_version           | Full Chrome version string, e.g. "124.0.6367.91"                          |
| chrome_major             | Chrome major version, parsed from chrome_version                          |
| yantra_version           | yantra CLI version from package.json                                      |
| initial_url              | First navigation URL captured during the session                          |
| capture_count            | Total number of captured actions                                          |
| dwell_per_page           | Time spent on each page URL during recording                              |
| stop_reason              | Why the recording ended                                                   |
| unrecorded_frame_origins | Cross-origin iframe origins detected but not instrumented — see TASK-006a |

Example:

```json
{
  "start_ts": "<start_ts>",
  "end_ts": "<end_ts>",
  "os": "<os>",
  "chrome_version": "<chrome_version>",
  "chrome_major": "<chrome_major>",
  "yantra_version": "<yantra_version>",
  "initial_url": "<initial_url>",
  "capture_count": "<capture_count>",
  "dwell_per_page": "<dwell_per_page>",
  "stop_reason": "<stop_reason>",
  "unrecorded_frame_origins": "<unrecorded_frame_origins>"
}
```

## RegexShape

Regex descriptor for workflow locator names.

| Field   | Description           |
| ------- | --------------------- |
| pattern | Regex source pattern. |
| flags   | Regex flags string.   |

Example:

```json
{
  "pattern": "<pattern>",
  "flags": "<flags>"
}
```

## RoleEnum

Supported ARIA role intents. Must stay a subset of the roles the locator engine can compute (`getRole`), or a recorded role can never match at replay: `<select>` computes `listbox`, `input[type=search]` computes `searchbox`, and `input[type=number|date|time|month|week]` computes `spinbutton`.

Example:

```json
"button"
```

## ScalarValue

Scalar value for task params.

Example:

```json
"<value>"
```

## SecretRef

Reference to a credential stored outside the plan payload.

| Field | Description                                                                       |
| ----- | --------------------------------------------------------------------------------- |
| kind  | Discriminator for secret references.                                              |
| key   | Secret key in namespace.name format.                                              |
| hosts | Trusted website hosts allowed to receive this secret. Required for browser fills. |

Example:

```json
{
  "kind": "<kind>",
  "key": "<key>",
  "hosts": "<hosts>"
}
```

## Section

A deep-detail prose section of the Brief.

| Field     | Description                                             |
| --------- | ------------------------------------------------------- |
| heading   | Section heading.                                        |
| body_md   | Markdown body prose; must not contain raw ANSI escapes. |
| citations | Source numbers (sources[].n) cited by this section.     |

Example:

```json
{
  "heading": "<heading>",
  "body_md": "<body_md>",
  "citations": "<citations>"
}
```

## SecurityClass

Top-level security class used by tasks and workflows.

Example:

```json
"public"
```

## SecurityScope

Step-level security scope.

Example:

```json
"public"
```

## Step

Single executable unit in a validated plan.

Example:

```json
"<value>"
```

## StopReasonSchema

No description provided.

Example:

```json
"user"
```

## TaskEvent

Discriminated union for task lifecycle events.

Example:

```json
"<value>"
```

## TaskRequest

Top-level task request entering the agent/executor pipeline.

| Field          | Description                                                                        |
| -------------- | ---------------------------------------------------------------------------------- |
| task_id        | Task identifier in ULID format.                                                    |
| type           | Task type in MVP.                                                                  |
| intent         | User-provided intent statement.                                                    |
| params         | Runtime parameters for task execution.                                             |
| data_refs      | Optional explicit secret references required by the task.                          |
| deadline_ms    | Optional overall deadline in milliseconds.                                         |
| budget         | Optional execution budget constraints.                                             |
| security_class | Security class for the task.                                                       |
| schema_version | Protocol schema version the request was authored under; legacy 0.1 stays accepted. |

Example:

```json
{
  "task_id": "<task_id>",
  "type": "<type>",
  "intent": "<intent>",
  "params": "<params>",
  "data_refs": "<data_refs>",
  "deadline_ms": "<deadline_ms>",
  "budget": "<budget>",
  "security_class": "<security_class>",
  "schema_version": "<schema_version>"
}
```

## TemplateRef

Templated value with explicit typed bindings.

| Field    | Description                                               |
| -------- | --------------------------------------------------------- |
| kind     | Discriminator for template-backed values.                 |
| template | Template string with {{placeholder}} markers.             |
| bindings | Typed mapping from placeholder names to value references. |

Example:

```json
{
  "kind": "<kind>",
  "template": "<template>",
  "bindings": "<bindings>"
}
```

## ToolAuditEntry

Stable append-only tool lifecycle entry stored in tool-calls.jsonl.

| Field            | Description                                                  |
| ---------------- | ------------------------------------------------------------ |
| ts               | ISO-8601 UTC timestamp for this lifecycle phase.             |
| seq              | Monotonic sequence number within the run.                    |
| run_id           | Owning Yantra run identifier.                                |
| session_id       | Owning provider session identifier.                          |
| call_id          | Provider tool-call identifier pairing start and end.         |
| tool             | Stable registered tool name.                                 |
| phase            | Tool-call lifecycle phase.                                   |
| input_sanitized  | Sanitized tool input, or null on end entries.                |
| output_sanitized | Sanitized tool output, or null on start entries.             |
| status           | Terminal tool status, or null on start entries.              |
| duration_ms      | Elapsed tool time in milliseconds, or null on start entries. |
| error_code       | Stable error code when present, otherwise null.              |
| confirmation_id  | Linked confirmation identifier when present, otherwise null. |

Example:

```json
{
  "ts": "<ts>",
  "seq": "<seq>",
  "run_id": "<run_id>",
  "session_id": "<session_id>",
  "call_id": "<call_id>",
  "tool": "<tool>",
  "phase": "<phase>",
  "input_sanitized": "<input_sanitized>",
  "output_sanitized": "<output_sanitized>",
  "status": "<status>",
  "duration_ms": "<duration_ms>",
  "error_code": "<error_code>",
  "confirmation_id": "<confirmation_id>"
}
```

## UsageCall

Single LLM usage call record.

| Field             | Description                                     |
| ----------------- | ----------------------------------------------- |
| step_id           | Owning step id, null for plan-generation calls. |
| model             | Model identifier.                               |
| provider          | Provider identifier.                            |
| input_tokens      | Input token count.                              |
| output_tokens     | Output token count.                             |
| cost_estimate_usd | Nullable estimated cost in USD.                 |
| latency_ms        | Call latency in milliseconds.                   |
| at                | ISO-8601 UTC timestamp.                         |

Example:

```json
{
  "step_id": "<step_id>",
  "model": "<model>",
  "provider": "<provider>",
  "input_tokens": "<input_tokens>",
  "output_tokens": "<output_tokens>",
  "cost_estimate_usd": "<cost_estimate_usd>",
  "latency_ms": "<latency_ms>",
  "at": "<at>"
}
```

## UsageLedger

Usage ledger persisted per run.

| Field  | Description                                                       |
| ------ | ----------------------------------------------------------------- |
| run_id | Owning run id.                                                    |
| calls  | Chronological call records.                                       |
| totals | Aggregated usage totals.                                          |
| agent  | Agentic-session totals when this run used the live agent runtime. |

Example:

```json
{
  "run_id": "<run_id>",
  "calls": "<calls>",
  "totals": "<totals>",
  "agent": "<agent>"
}
```

## UsageProvider

Provider used for the model call.

Example:

```json
"anthropic"
```

## ValueRef

No description provided.

Example:

```json
"<value>"
```

## WaitActionSchema

A wait/dwell event between user actions

| Field       | Description                      |
| ----------- | -------------------------------- |
| kind        |                                  |
| ts          |                                  |
| reason      |                                  |
| duration_ms | Dwell duration in milliseconds   |
| url         | URL of the page during the dwell |

Example:

```json
{
  "kind": "<kind>",
  "ts": "<ts>",
  "reason": "<reason>",
  "duration_ms": "<duration_ms>",
  "url": "<url>"
}
```

## WaitForStep

Wait for target element state transitions.

| Field                 | Description                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| id                    | Step identifier, unique within the plan.                                                                                  |
| scope                 | Step scope; null inherits the plan default.                                                                               |
| requires_confirmation | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, and navigate steps. |
| type                  | Wait-for step discriminator.                                                                                              |
| locator               | Locator chain for awaited target.                                                                                         |
| state                 | Target state to wait for.                                                                                                 |
| timeout_ms            | Optional timeout override.                                                                                                |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
  "requires_confirmation": "<requires_confirmation>",
  "type": "<type>",
  "locator": "<locator>",
  "state": "<state>",
  "timeout_ms": "<timeout_ms>"
}
```

## WorkflowFile

Workflow YAML schema source used by parser, linter, and editor integrations.

| Field               | Description                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| version             | Workflow format major version.                                                                                |
| name                | Workflow slug name.                                                                                           |
| description         | Optional workflow description.                                                                                |
| security_class      | Workflow security class.                                                                                      |
| recorded_with       | Optional recording metadata.                                                                                  |
| params              | Workflow parameter declarations.                                                                              |
| secrets             | Declared workflow secret keys.                                                                                |
| cookies             | Cookie/profile handling mode.                                                                                 |
| steps               | Ordered workflow steps.                                                                                       |
| outputs             | Workflow output declarations.                                                                                 |
| synthesis           | Optional post-execution synthesis intent; null (the default) means the run reports its declared outputs only. |
| outputs_unredacted  | Whether outputs bypass redaction safeguards.                                                                  |
| \_unrecorded_frames | Cross-origin frames not instrumented at record time.                                                          |
| \_locators          | Named locator chains captured or authored for replay.                                                         |

Example:

```json
{
  "version": "<version>",
  "name": "<name>",
  "description": "<description>",
  "security_class": "<security_class>",
  "recorded_with": "<recorded_with>",
  "params": "<params>",
  "secrets": "<secrets>",
  "cookies": "<cookies>",
  "steps": "<steps>",
  "outputs": "<outputs>",
  "synthesis": "<synthesis>",
  "outputs_unredacted": "<outputs_unredacted>",
  "_unrecorded_frames": "<_unrecorded_frames>",
  "_locators": "<_locators>"
}
```

## WorkflowOutput

Workflow output binding.

| Field | Description                                |
| ----- | ------------------------------------------ |
| name  | Workflow output key.                       |
| from  | Template expression sourcing output value. |

Example:

```json
{
  "name": "<name>",
  "from": "<from>"
}
```

## WorkflowStep

Workflow-friendly step union mirroring protocol step verbs.

Example:

```json
"<value>"
```

## WorkflowSynthesis

Optional post-execution synthesis intent producing a Brief from recorded reads.

| Field   | Description                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| goal    | The question or topic the synthesized Brief must answer.                                                                                                                                                                              |
| length  | Findings/sections budget for the Brief: short=3, medium=6, long=10 findings.                                                                                                                                                          |
| detail  | Brief depth: overview omits sections, standard adds them, full adds comparison facets.                                                                                                                                                |
| use_llm | Whether a model may write this Brief. Set when promoting a run whose report a model authored; false (the default) keeps replay model-free. `yantra run --no-llm`, scheduled runs, and nested workflow_run calls override it to false. |

Example:

```json
{
  "goal": "<goal>",
  "length": "<length>",
  "detail": "<detail>",
  "use_llm": "<use_llm>"
}
```

## WorkflowValueExpression

Workflow value expression or scalar literal.

Example:

```json
"<value>"
```
