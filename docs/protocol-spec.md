# Protocol Spec

> DO NOT EDIT - regenerated from packages/protocol

Current schema version: **0.2**. Accepted versions: 0.1, 0.2.
The 0.2 bump is additive: it introduces the Brief document type; Plan and workflow contracts are unchanged and 0.1 documents remain valid.

## ActionId

Run-wide action identifier, equal to A followed by the ledger sequence.

Example:

```json
"<value>"
```

## AdapterId

Identifier of an app-side adapter for an exceptional command.

Example:

```json
"init-onboarding"
```

## AgentManifestSection

Stable agent metadata embedded in manifest.json for one run-local session.

| Field             | Description                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| adapter           | Agent adapter used for this run.                                                                             |
| sdk_version       | Installed provider SDK version resolved at runtime.                                                          |
| provider          | Effective model provider identifier.                                                                         |
| model             | Effective provider-scoped model identifier.                                                                  |
| thinking          | Effective model thinking or reasoning level.                                                                 |
| thinking_source   | Origin of the effective thinking level.                                                                      |
| auth_source       | Credential source used to open the session; never credential material.                                       |
| session_id        | Provider-assigned session identifier.                                                                        |
| session_file      | Relative path from the run directory to the provider session JSONL.                                          |
| prompt_version    | Version of the authoritative agent prompt.                                                                   |
| prompt_hash       | SHA-256 of the exact system prompt.                                                                          |
| tool_catalog_hash | SHA-256 of the canonical tool catalog serialization.                                                         |
| yantra_version    | Version of the Yantra agent package that ran; absent on older manifests.                                     |
| budgets           | Effective run budgets; absent on older manifests.                                                            |
| capture           | Both capture capabilities with reason codes, resolved before the first tool call; absent on older manifests. |

Example:

```json
{
  "adapter": "<adapter>",
  "sdk_version": "<sdk_version>",
  "provider": "<provider>",
  "model": "<model>",
  "thinking": "<thinking>",
  "thinking_source": "<thinking_source>",
  "auth_source": "<auth_source>",
  "session_id": "<session_id>",
  "session_file": "<session_file>",
  "prompt_version": "<prompt_version>",
  "prompt_hash": "<prompt_hash>",
  "tool_catalog_hash": "<tool_catalog_hash>",
  "yantra_version": "<yantra_version>",
  "budgets": "<budgets>",
  "capture": "<capture>"
}
```

## AgentProgressEvent

Agent progress event, discriminated by `type` (the connector shape).

Example:

```json
"<value>"
```

## AgentRunBudgets

Effective budgets for one agentic run.

| Field                    | Description                                                    |
| ------------------------ | -------------------------------------------------------------- |
| turn_timeout_ms          | Maximum thinking time per provider turn in milliseconds.       |
| wall_clock_ms            | Run wall-clock budget, or null if unbounded.                   |
| soft_wall_clock_fraction | Fraction of the wall clock after which exploration winds down. |
| max_provider_tokens      | Provider-token budget, or null if unbounded.                   |
| max_navigations          | Browser navigation budget.                                     |
| max_hosts                | Distinct-host budget.                                          |
| tool_retries             | Consecutive failed tool calls the breaker tolerates.           |

Example:

```json
{
  "turn_timeout_ms": "<turn_timeout_ms>",
  "wall_clock_ms": "<wall_clock_ms>",
  "soft_wall_clock_fraction": "<soft_wall_clock_fraction>",
  "max_provider_tokens": "<max_provider_tokens>",
  "max_navigations": "<max_navigations>",
  "max_hosts": "<max_hosts>",
  "tool_retries": "<tool_retries>"
}
```

## AgentUsageTotals

Aggregated provider usage for an agentic run.

| Field            | Description                                                          |
| ---------------- | -------------------------------------------------------------------- |
| reasoning_tokens | Reasoning tokens, or null when unreported.                           |
| turns            | Completed provider turns.                                            |
| input_tokens     | Agent input tokens, or null when the provider does not report them.  |
| output_tokens    | Agent output tokens, or null when the provider does not report them. |
| cost_usd         | Agent cost in USD, or null when the provider does not report it.     |

Example:

```json
{
  "reasoning_tokens": "<reasoning_tokens>",
  "turns": "<turns>",
  "input_tokens": "<input_tokens>",
  "output_tokens": "<output_tokens>",
  "cost_usd": "<cost_usd>"
}
```

## AppRpcAuth

First message on every socket; must match the cookie’s window.

| Field   | Description |
| ------- | ----------- |
| jsonrpc |             |
| method  |             |
| params  |             |

Example:

```json
{
  "jsonrpc": "<jsonrpc>",
  "method": "<method>",
  "params": "<params>"
}
```

## AppRpcErrorData

Detail of a JSON-RPC error.

| Field       | Description                                            |
| ----------- | ------------------------------------------------------ |
| code        | Stable machine-readable reason, e.g. `invalid_params`. |
| message     | What actually happened.                                |
| remediation | One next step, when there is one.                      |

Example:

```json
{
  "code": "<code>",
  "message": "<message>",
  "remediation": "<remediation>"
}
```

## ArgumentSpec

One positional argument.

| Field       | Description                                                      |
| ----------- | ---------------------------------------------------------------- |
| name        | Argument name as commander shows it, e.g. "run-id".              |
| description | Help-visible description (may be empty).                         |
| required    | "<x>" when true, "[x]" when false.                               |
| variadic    | Whether it collects all remaining operands.                      |
| default     | Commander parse default for an optional argument, shown in help. |
| input       | How a generated form collects this value.                        |

Example:

```json
{
  "name": "<name>",
  "description": "<description>",
  "required": "<required>",
  "variadic": "<variadic>",
  "default": "<default>",
  "input": "<input>"
}
```

## ArtifactInventoryItem

One public run file.

| Field           | Description                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| path            | Run-relative path, forward slashes.                                                                                                                                |
| entry_id        | The RUN_ARTIFACT_REGISTRY entry it matched.                                                                                                                        |
| exposure        | typed: only through a typed read (e.g. brief.json through read.run_result); view: through a bounded viewer; download: only as an attachment; denied: never served. |
| viewer          | The bounded viewer that opens the file; `none` when no viewer exists.                                                                                              |
| bytes           |                                                                                                                                                                    |
| modified_at     |                                                                                                                                                                    |
| over_inline_cap | Larger than its viewer loads whole.                                                                                                                                |

Example:

```json
{
  "path": "<path>",
  "entry_id": "<entry_id>",
  "exposure": "<exposure>",
  "viewer": "<viewer>",
  "bytes": "<bytes>",
  "modified_at": "<modified_at>",
  "over_inline_cap": "<over_inline_cap>"
}
```

## ArtifactKind

What kind of file the artifact is.

Example:

```json
"screenshot"
```

## ArtifactRef

One file a tool call wrote to the run directory: metadata only, never image bytes or a data URI.

| Field         | Description                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| kind          | What kind of file the artifact is.                                                                                   |
| path          | Run-relative path of the artifact file, using forward slashes.                                                       |
| sha256        | Lowercase hex SHA-256 of the file bytes.                                                                             |
| mime_type     | Media type of the file.                                                                                              |
| bytes         | File size in bytes.                                                                                                  |
| width         | Image width in pixels.                                                                                               |
| height        | Image height in pixels.                                                                                              |
| sent_to_model | True only when the image was shown to the model provider (Vision Assist); false for a capture kept on this computer. |

Example:

```json
{
  "kind": "<kind>",
  "path": "<path>",
  "sha256": "<sha256>",
  "mime_type": "<mime_type>",
  "bytes": "<bytes>",
  "width": "<width>",
  "height": "<height>",
  "sent_to_model": "<sent_to_model>"
}
```

## ArtifactScope

What a screenshot covers: the visible viewport, the full page, or one element.

Example:

```json
"viewport"
```

## ArtifactSlotState

No description provided.

Example:

```json
"ok"
```

## ArtifactUrlParams

Ask for a signed, window-bound URL to one public run artifact.

| Field  | Description                                       |
| ------ | ------------------------------------------------- |
| run_id | The run the artifact belongs to.                  |
| path   | Path inside the run directory, with / separators. |

Example:

```json
{
  "run_id": "<run_id>",
  "path": "<path>"
}
```

## ArtifactUrlResult

No description provided.

| Field      | Description                                                    |
| ---------- | -------------------------------------------------------------- |
| url        | Same-origin URL, valid for 5 minutes and only for this window. |
| expires_at |                                                                |

Example:

```json
{
  "url": "<url>",
  "expires_at": "<expires_at>"
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

| Field                 | Description                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| id                    | Step identifier, unique within the plan.                                                                                                |
| scope                 | Step scope; null inherits the plan default.                                                                                             |
| requires_confirmation | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, fill_element, and navigate steps. |
| type                  | Assert step discriminator.                                                                                                              |
| locator               | Locator chain for assertion target.                                                                                                     |
| condition             | Assertion condition payload.                                                                                                            |

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

| Field                 | Description                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| id                    | Step identifier, unique within the plan.                                                                                                |
| scope                 | Step scope; null inherits the plan default.                                                                                             |
| requires_confirmation | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, fill_element, and navigate steps. |
| type                  | Branch step discriminator.                                                                                                              |
| condition             | Branch condition payload.                                                                                                               |
| then_step_id          | Step id for true branch.                                                                                                                |
| else_step_id          | Optional step id for false branch.                                                                                                      |

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

| Field          | Description                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| actions        | Cited action evidence, in first-citation order; absent on older Briefs.                                                          |
| brief_id       | Unique Brief document id (ULID).                                                                                                 |
| task_id        | Originating task id (ULID).                                                                                                      |
| schema_version | Protocol schema version this document was written under.                                                                         |
| title          | One-line document title.                                                                                                         |
| overview       | Answer-first Markdown synthesis (1-3 paragraphs) with inline [n] citations.                                                      |
| key_findings   | Scannable findings; may be empty.                                                                                                |
| sections       | Deep-detail sections; empty at the overview synthesis budget.                                                                    |
| facets         | Structured/tabular facets, or null when the query has no comparative shape.                                                      |
| sources        | Numbered, deduplicated source references.                                                                                        |
| constraints    | Declared conditions and their delivery statuses; absent on older artifacts.                                                      |
| requirements   | Each declared requirement of a do task and its evidence-judged status; absent on older artifacts and on ask and research Briefs. |
| artifacts      | Saved capture files of a do task, one entry per file in capture order; absent on older artifacts and on ask and research Briefs. |
| metadata       | Provenance and quality signals.                                                                                                  |
| notices        | Honest per-source failures and validator flags; may be empty.                                                                    |

Example:

```json
{
  "actions": "<actions>",
  "brief_id": "<brief_id>",
  "task_id": "<task_id>",
  "schema_version": "<schema_version>",
  "title": "<title>",
  "overview": "<overview>",
  "key_findings": "<key_findings>",
  "sections": "<sections>",
  "facets": "<facets>",
  "sources": "<sources>",
  "constraints": "<constraints>",
  "requirements": "<requirements>",
  "artifacts": "<artifacts>",
  "metadata": "<metadata>",
  "notices": "<notices>"
}
```

## BriefAction

One cited, verified browser action: identities and verdicts only, never field values.

| Field        | Description                                                             |
| ------------ | ----------------------------------------------------------------------- |
| id           | Run-wide action identifier, equal to A followed by the ledger sequence. |
| kind         | Verified action kind.                                                   |
| label        | Sanitized field or control label; null when no label is known.          |
| label_origin | Evidence from which the fill label was resolved.                        |
| confidence   | Confidence of an inferred label.                                        |
| section      | Sanitized form section containing the field.                            |
| ref          | Page-scoped target reference.                                           |
| epoch        | Committed document epoch when the action happened.                      |
| call_id      | Provider tool-call identifier, or null for a direct execution.          |
| host         | Page hostname at action time, or null when unknown.                     |
| verification | Fill verification without any committed value.                          |
| signal       | Signal that caused a submit refusal.                                    |
| artifacts    | Every saved file of a capture action.                                   |

Example:

```json
{
  "id": "<id>",
  "kind": "<kind>",
  "label": "<label>",
  "label_origin": "<label_origin>",
  "confidence": "<confidence>",
  "section": "<section>",
  "ref": "<ref>",
  "epoch": "<epoch>",
  "call_id": "<call_id>",
  "host": "<host>",
  "verification": "<verification>",
  "signal": "<signal>",
  "artifacts": "<artifacts>"
}
```

## BriefArtifact

One saved capture file the run produced, linked relative to the run directory.

| Field    | Description                                                                     |
| -------- | ------------------------------------------------------------------------------- |
| kind     | The artifact kind.                                                              |
| scope    | What a screenshot covers: the visible viewport, the full page, or one element.  |
| path     | Run-relative path of the artifact file, using forward slashes.                  |
| sha256   | Lowercase hex SHA-256 of the file bytes.                                        |
| bytes    | File size in bytes.                                                             |
| width    | Image width in pixels.                                                          |
| height   | Image height in pixels.                                                         |
| part     | 1-based position of this file in its capture set.                               |
| parts    | How many files the capture set holds.                                           |
| complete | False when the set was clipped or truncated and does not show the whole target. |
| labels   | Labels on the capture set.                                                      |

Example:

```json
{
  "kind": "<kind>",
  "scope": "<scope>",
  "path": "<path>",
  "sha256": "<sha256>",
  "bytes": "<bytes>",
  "width": "<width>",
  "height": "<height>",
  "part": "<part>",
  "parts": "<parts>",
  "complete": "<complete>",
  "labels": "<labels>"
}
```

## BriefConstraint

A declared condition and its evidence-backed delivery status.

| Field     | Description                                                         |
| --------- | ------------------------------------------------------------------- |
| name      | Condition name from the task contract.                              |
| value     | Condition value.                                                    |
| status    | Whether the condition is confirmed, unknown, or not met.            |
| citations | Evidence backing the status; verified requires at least one source. |

Example:

```json
{
  "name": "<name>",
  "value": "<value>",
  "status": "<status>",
  "citations": "<citations>"
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

| Field  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| source | Host or subsystem the notice concerns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| reason | Human-readable reason for the notice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| kind   | Notice classification. `contract_gap` marks a part of the declared task contract not delivered, a condition not confirmed or not met, or rows shown as alternatives because they do not come from a required source. `source_excluded` marks a source dropped as irrelevant to the query before assembly; `limited_evidence` marks a Brief that fell short of the requested length because too few relevant findings survived the evidence gates; `search_failed` marks web searches that failed during the run, grouped by stable failure code (source `search:<provider>`); `budget_exhausted` marks a run budget (navigations, hosts) that Yantra itself imposed running out, never a site refusing access. |

Example:

```json
{
  "source": "<source>",
  "reason": "<reason>",
  "kind": "<kind>"
}
```

## BriefRequirement

One declared requirement of the task contract and its evidence-judged status.

| Field           | Description                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------- |
| id              | Requirement id: deliverable, filter:<name>, fill, artifact:screenshot:<scope>, or effects.submit. |
| label           | Plain-words name of the requirement.                                                              |
| status          | Whether evidence shows the requirement met, unmet, or not applicable.                             |
| reason          | What the evidence showed, or null when nothing needs saying.                                      |
| declared_in     | The contract revision that declared the requirement, or null when not tracked.                    |
| exemptions      | Controls the engine judged exempt from the fill requirement.                                      |
| exempt_overflow | How many more exempt controls exist beyond the listed ones.                                       |

Example:

```json
{
  "id": "<id>",
  "label": "<label>",
  "status": "<status>",
  "reason": "<reason>",
  "declared_in": "<declared_in>",
  "exemptions": "<exemptions>",
  "exempt_overflow": "<exempt_overflow>"
}
```

## BriefSlot

One artifact: ok with its value, or missing, corrupt, unsupported, too large or denied.

Example:

```json
"<value>"
```

## BriefSource

A numbered, deduplicated source reference.

| Field        | Description                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| cited        | True for evidence cited by the answer; false for consulted-only sources. All-or-none across sources. |
| n            | Citation number; contiguous 1..N in array order.                                                     |
| url          | URL as fetched.                                                                                      |
| final_url    | Post-redirect landing URL, or null when no redirect was observed.                                    |
| host         | Source host.                                                                                         |
| title        | Page title, or null when unavailable.                                                                |
| excerpt      | Short extracted snippet of the source content, or null when not captured.                            |
| fetched_at   | ISO-8601 UTC fetch timestamp.                                                                        |
| published_at | ISO-8601 publication timestamp, or null when unknown.                                                |

Example:

```json
{
  "cited": "<cited>",
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

| Field                 | Description                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| id                    | Step identifier, unique within the plan.                                                                                                |
| scope                 | Step scope; null inherits the plan default.                                                                                             |
| requires_confirmation | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, fill_element, and navigate steps. |
| type                  | Call-workflow step discriminator.                                                                                                       |
| workflow_name         | Name of workflow to invoke.                                                                                                             |
| params                | Param values passed to called workflow.                                                                                                 |
| capture_as            | Optional capture alias for workflow output.                                                                                             |

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

## CaptureCapabilityRecord

The run's two capture capabilities, resolved before the first tool call.

| Field         | Description                                                                                |
| ------------- | ------------------------------------------------------------------------------------------ |
| vision_assist | Whether Vision Assist (screenshots sent to the model) is available, and why not.           |
| deliverable   | Whether deliverable capture (screenshots kept on this computer) is available, and why not. |

Example:

```json
{
  "vision_assist": "<vision_assist>",
  "deliverable": "<deliverable>"
}
```

## CaptureLabel

A label on a capture set: clipped_width, truncated, or beyond_viewport.

Example:

```json
"clipped_width"
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

| Field                    | Description                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| id                       | Step identifier, unique within the plan.                                                                                                |
| scope                    | Step scope; null inherits the plan default.                                                                                             |
| requires_confirmation    | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, fill_element, and navigate steps. |
| confirmation_description | Human-readable override for the consent card. Falls back to step name when null.                                                        |
| expected_cost            | Best-effort cost estimate shown on the consent card, or null if unknown.                                                                |
| consequence              | Reversibility hint for the action, or null to default to "unknown".                                                                     |
| type                     | Click step discriminator.                                                                                                               |
| locator                  | Locator chain for click target.                                                                                                         |
| modifiers                | Optional click modifier keys.                                                                                                           |

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

## CommandEntry

A group or an executable leaf.

Example:

```json
"<value>"
```

## CommandInvocation

A requested command invocation.

| Field         | Description                                                            |
| ------------- | ---------------------------------------------------------------------- |
| invocation_id | Client-generated ULID; the idempotency key for launching (D11).        |
| path          | Canonical command path, aliases resolved (e.g. ["do"] for "discover"). |
| argv          | Tokens after the path, exactly as given, in order.                     |
| cwd           | Absolute working directory the invocation was requested from.          |

Example:

```json
{
  "invocation_id": "<invocation_id>",
  "path": "<path>",
  "argv": "<argv>",
  "cwd": "<cwd>"
}
```

## CommandInvokeParams

Launch a run-class or mutating command as a detached worker.

| Field               | Description                                            |
| ------------------- | ------------------------------------------------------ |
| invocation          | What to run; its invocation_id is the idempotency key. |
| displayed_effective | What the composer showed (the drift baseline).         |

Example:

```json
{
  "invocation": "<invocation>",
  "displayed_effective": "<displayed_effective>"
}
```

## CommandRegistry

The complete Yantra command surface.

| Field            | Description                                                                 |
| ---------------- | --------------------------------------------------------------------------- |
| registry_version | Bumped on any breaking shape change.                                        |
| program          | Root command metadata. The version string stays runtime-derived in the CLI. |
| option_groups    | Named option groups.                                                        |
| commands         | Entries in root-help order: each group is followed by its subcommands.      |

Example:

```json
{
  "registry_version": "<registry_version>",
  "program": "<program>",
  "option_groups": "<option_groups>",
  "commands": "<commands>"
}
```

## CommandResultMessageSchema

The final completion of a command executed on a worker surface.

Example:

```json
"<value>"
```

## Condition

A predicate over one parsed invocation.

Example:

```json
"<value>"
```

## ConfirmationDecidedBy

Who or what resolved the confirmation — no agent variant exists. user_interactive: a person at the terminal prompt; user_cli_confirm: a person running `yantra confirm`; timeout: the bounded wait expired; user_app: a person answered in the Yantra app (FEAT-068; added in FEAT-063, readable by new executables only).

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

## ContentIdentitySchema

A content identity at execution start.

| Field  | Description                             |
| ------ | --------------------------------------- |
| kind   |                                         |
| path   | Absolute path read at invocation start. |
| sha256 | Streamed SHA-256 of the exact content.  |

Example:

```json
{
  "kind": "<kind>",
  "path": "<path>",
  "sha256": "<sha256>"
}
```

## ContractRequirementOrigin

An action requirement still in force and the revision that declared it.

| Field       | Description                                                       |
| ----------- | ----------------------------------------------------------------- |
| id          | The requirement id, such as fill or artifact:screenshot:viewport. |
| declared_in | The revision that first declared this requirement.                |

Example:

```json
{
  "id": "<id>",
  "declared_in": "<declared_in>"
}
```

## ControlClientMessage

A control-socket message from a client to the app host.

Example:

```json
"<value>"
```

## ControlServerMessage

A control-socket message from the app host to a client.

Example:

```json
"<value>"
```

## DangerSpec

Whether a generated surface must ask for explicit confirmation first.

Example:

```json
"<value>"
```

## DeliverableCaptureCapability

Whether deliverable capture (screenshots kept on this computer) is available, and why not.

| Field     | Description                                                      |
| --------- | ---------------------------------------------------------------- |
| available | Whether the capability is registered for this run.               |
| reasons   | Every condition that keeps it off; empty exactly when available. |

Example:

```json
{
  "available": "<available>",
  "reasons": "<reasons>"
}
```

## DeliverableCaptureReason

A condition that keeps deliverable capture off.

Example:

```json
"suppressed_by_flag"
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

## DisplayedEffective

What the composer showed at submission (D13): the baseline for queue drift review. Never holds a secret.

| Field    | Description                                                            |
| -------- | ---------------------------------------------------------------------- |
| settings | Effective non-secret settings the composer showed, with their sources. |
| content  | Workflow and template content identities the composer showed.          |

Example:

```json
{
  "settings": "<settings>",
  "content": "<content>"
}
```

## DriftDifference

One setting or content identity that changed while queued.

| Field     | Description                                                      |
| --------- | ---------------------------------------------------------------- |
| key       | Setting key, or `content:<path>` for a content identity.         |
| submitted | The value shown at submission.                                   |
| current   | The value now; null when it no longer exists.                    |
| pinnable  | True when the submitted value can be pinned as an explicit flag. |

Example:

```json
{
  "key": "<key>",
  "submitted": "<submitted>",
  "current": "<current>",
  "pinnable": "<pinnable>"
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

## EmptyParams

No parameters.

Example:

```json
{}
```

## ExecutionClass

How a surface executes the command: run (detached worker, slot counted), read (host, in-process), mutate (short-lived worker under locks), exclusive (blocks run starts), in-process-secure (value never in argv), adapter (an app-side adapter replaces the generated surface), exemption (a reviewed decision keeps it terminal-only).

Example:

```json
"run"
```

## ExecutionReceiptSchema

Immutable execution settings and content identities for one run start or resume.

| Field          | Description                                                                |
| -------------- | -------------------------------------------------------------------------- |
| schema_version |                                                                            |
| run_id         |                                                                            |
| sequence       |                                                                            |
| written_at     |                                                                            |
| yantra_version |                                                                            |
| invoked_by     |                                                                            |
| invocation_id  |                                                                            |
| command        |                                                                            |
| cwd            |                                                                            |
| settings       | Effective settings, sorted by key; no secrets or unrelated environment.    |
| content        |                                                                            |
| browser        | Browser selection at start; no profile contents or installation telemetry. |

Example:

```json
{
  "schema_version": "<schema_version>",
  "run_id": "<run_id>",
  "sequence": "<sequence>",
  "written_at": "<written_at>",
  "yantra_version": "<yantra_version>",
  "invoked_by": "<invoked_by>",
  "invocation_id": "<invocation_id>",
  "command": "<command>",
  "cwd": "<cwd>",
  "settings": "<settings>",
  "content": "<content>",
  "browser": "<browser>"
}
```

## ExecutionRule

When `when` holds, the command executes as `class`. The first matching rule wins.

| Field | Description                                                                                                                                                                                                                                                                                                                              |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| when  | A predicate over one parsed invocation.                                                                                                                                                                                                                                                                                                  |
| class | How a surface executes the command: run (detached worker, slot counted), read (host, in-process), mutate (short-lived worker under locks), exclusive (blocks run starts), in-process-secure (value never in argv), adapter (an app-side adapter replaces the generated surface), exemption (a reviewed decision keeps it terminal-only). |

Example:

```json
{
  "when": "<when>",
  "class": "<class>"
}
```

## ExecutionSpec

The execution class, possibly option-dependent.

| Field     | Description                                     |
| --------- | ----------------------------------------------- |
| default   | Class when no rule matches.                     |
| rules     | Ordered rules; the first match wins.            |
| adapter   | Required when any reachable class is adapter.   |
| exemption | Required when any reachable class is exemption. |

Example:

```json
{
  "default": "<default>",
  "rules": "<rules>",
  "adapter": "<adapter>",
  "exemption": "<exemption>"
}
```

## ExecutionState

Set only by the reconciler when the owning process died before writing a terminal result (plan D7). Separate from the outcome, which follows the evidence and is never `aborted`. Absent for every run that ended on its own.

Example:

```json
"interrupted"
```

## ExitCode

No description provided.

Example:

```json
"<value>"
```

## ExitCodeSpec

One exit code the command can return.

| Field   | Description                                                          |
| ------- | -------------------------------------------------------------------- |
| code    | 0 success, 1 validation, 2 execution, 3 environment, 4 user handoff. |
| meaning | What this code means for this command.                               |

Example:

```json
{
  "code": "<code>",
  "meaning": "<meaning>"
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

| Field                 | Description                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| id                    | Step identifier, unique within the plan.                                                                                                |
| scope                 | Step scope; null inherits the plan default.                                                                                             |
| requires_confirmation | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, fill_element, and navigate steps. |
| type                  | Extract step discriminator.                                                                                                             |
| locator               | Locator chain for extraction target.                                                                                                    |
| extraction_schema     | Expected extracted data shape.                                                                                                          |
| capture_as            | Capture alias for downstream references.                                                                                                |

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

## FillElementStep

Resolve and semantically fill one browser field.

| Field                    | Description                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| id                       | Step identifier, unique within the plan.                                                                                                |
| scope                    | Step scope; null inherits the plan default.                                                                                             |
| requires_confirmation    | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, fill_element, and navigate steps. |
| confirmation_description | Human-readable override for the consent card. Falls back to step name when null.                                                        |
| expected_cost            | Best-effort cost estimate shown on the consent card, or null if unknown.                                                                |
| consequence              | Reversibility hint for the action, or null to default to "unknown".                                                                     |
| type                     | Semantic fill-element step discriminator.                                                                                               |
| field_name               | Accessible field name used for fresh resolution.                                                                                        |
| field_label_origin       | How field_name was derived when it is not the control's accessible name. Absent means accessible name.                                  |
| locator                  | Fallback locator chain for the target field.                                                                                            |
| value                    | Semantic value committed through the unified fill engine.                                                                               |

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
  "field_name": "<field_name>",
  "field_label_origin": "<field_label_origin>",
  "locator": "<locator>",
  "value": "<value>"
}
```

## FillExemption

Why the engine left a form control out of "fill every eligible field".

Example:

```json
"disabled"
```

## FillStep

Fill an input-like field.

| Field                    | Description                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| id                       | Step identifier, unique within the plan.                                                                                                |
| scope                    | Step scope; null inherits the plan default.                                                                                             |
| requires_confirmation    | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, fill_element, and navigate steps. |
| confirmation_description | Human-readable override for the consent card. Falls back to step name when null.                                                        |
| expected_cost            | Best-effort cost estimate shown on the consent card, or null if unknown.                                                                |
| consequence              | Reversibility hint for the action, or null to default to "unknown".                                                                     |
| type                     | Fill step discriminator.                                                                                                                |
| locator                  | Locator chain for fill target.                                                                                                          |
| value                    | Value inserted into the target input.                                                                                                   |
| submit                   | Whether to submit after filling.                                                                                                        |

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

## GroupEntry

A command with subcommands and no action.

| Field        | Description                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| kind         |                                                                                                                                                          |
| id           | Dotted path, e.g. "config.data-dir". Equals path.join(".").                                                                                              |
| path         | Command tokens from the root.                                                                                                                            |
| description  | Help-visible description.                                                                                                                                |
| help_after   | Text added with addHelpText('after', …).                                                                                                                 |
| registration | subcommand: created with parent.command() and inherits parent settings such as showHelpAfterError; added: new Command() plus addCommand, which does not. |

Example:

```json
{
  "kind": "<kind>",
  "id": "<id>",
  "path": "<path>",
  "description": "<description>",
  "help_after": "<help_after>",
  "registration": "<registration>"
}
```

## HandoffReason

Reason human intervention is required.

Example:

```json
"captcha"
```

## HostBuildNotification

The build the host serves, repeated on every connect.

| Field    | Description |
| -------- | ----------- |
| build_id |             |

Example:

```json
{
  "build_id": "<build_id>"
}
```

## HostHelloParams

No description provided.

| Field           | Description                                            |
| --------------- | ------------------------------------------------------ |
| build_id        | The build ID in the page’s `yantra-build-id` meta tag. |
| channel_version | The app channel version the page speaks.               |

Example:

```json
{
  "build_id": "<build_id>",
  "channel_version": "<channel_version>"
}
```

## HostHelloResult

No description provided.

| Field           | Description                                                     |
| --------------- | --------------------------------------------------------------- |
| build_id        | The build the host serves; a mismatch means stale assets (D17). |
| channel_version |                                                                 |
| yantra_version  |                                                                 |
| server_time     | The host clock, for the app’s relative times.                   |

Example:

```json
{
  "build_id": "<build_id>",
  "channel_version": "<channel_version>",
  "yantra_version": "<yantra_version>",
  "server_time": "<server_time>"
}
```

## HostLockRecord

The single-instance app host lock, one per data directory.

| Field           | Description                                                                 |
| --------------- | --------------------------------------------------------------------------- |
| schema_version  | Record format version.                                                      |
| state           | `starting` from acquisition until both listeners are bound, then `ready`.   |
| pid             | Host process ID.                                                            |
| start_token     | Host process creation token.                                                |
| port            | Loopback HTTP port; set when `ready`.                                       |
| control_socket  | Control socket path (POSIX) or named-pipe name (Windows); set when `ready`. |
| control_token   | 256-bit base64url token a control client must send first.                   |
| build_id        | ID of the embedded web build the host serves.                               |
| yantra_version  | Version of the Yantra executable running the host.                          |
| channel_version | App channel version (D17).                                                  |
| started_at      | When the host acquired the lock.                                            |
| env_captured_at | When the host captured the environment it gives workers (D13).              |

Example:

```json
{
  "schema_version": "<schema_version>",
  "state": "<state>",
  "pid": "<pid>",
  "start_token": "<start_token>",
  "port": "<port>",
  "control_socket": "<control_socket>",
  "control_token": "<control_token>",
  "build_id": "<build_id>",
  "yantra_version": "<yantra_version>",
  "channel_version": "<channel_version>",
  "started_at": "<started_at>",
  "env_captured_at": "<env_captured_at>"
}
```

## InputKind

How a generated form collects this value.

Example:

```json
"<value>"
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

## InvocationFinishReason

`owner_lost`: the worker died and was reconciled; `busy`: the run was owned elsewhere; `refused_claim`: the worker found the item withdrawn.

Example:

```json
"owner_lost"
```

## InvocationIdParams

No description provided.

| Field         | Description |
| ------------- | ----------- |
| invocation_id |             |

Example:

```json
{
  "invocation_id": "<invocation_id>"
}
```

## InvocationRecord

One app-launched invocation and its launch-ownership state (D11).

| Field                       | Description                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| schema_version              | Record format version.                                                                                   |
| invocation_id               | Client-generated idempotency key; unique by file name.                                                   |
| invocation                  | What was requested (FEAT-062).                                                                           |
| execution_class             | Execution class resolved from the registry for these options at submission.                              |
| state                       | Launch-ownership state of one app invocation.                                                            |
| queued_at                   | Submission time; FIFO order is by this, then the ID.                                                     |
| updated_at                  | Time of the last state change.                                                                           |
| displayed_effective         | What the composer showed at submission (D13): the baseline for queue drift review. Never holds a secret. |
| run_id                      | Run ID allocated at `reserved` (the existing run for `resume`).                                          |
| worker                      | Set only by the worker, through its claim.                                                               |
| review                      | Set on `needs_review`.                                                                                   |
| duplicate_risk_acknowledged | Must be true to start a `start_unknown` item again.                                                      |
| result                      | Set on `finished`.                                                                                       |

Example:

```json
{
  "schema_version": "<schema_version>",
  "invocation_id": "<invocation_id>",
  "invocation": "<invocation>",
  "execution_class": "<execution_class>",
  "state": "<state>",
  "queued_at": "<queued_at>",
  "updated_at": "<updated_at>",
  "displayed_effective": "<displayed_effective>",
  "run_id": "<run_id>",
  "worker": "<worker>",
  "review": "<review>",
  "duplicate_risk_acknowledged": "<duplicate_risk_acknowledged>",
  "result": "<result>"
}
```

## InvocationResult

A detached worker's completion: the command's result or error, written once.

| Field          | Description                                                     |
| -------------- | --------------------------------------------------------------- |
| schema_version |                                                                 |
| invocation_id  |                                                                 |
| run_id         |                                                                 |
| outcome        | The final completion of a command executed on a worker surface. |

Example:

```json
{
  "schema_version": "<schema_version>",
  "invocation_id": "<invocation_id>",
  "run_id": "<run_id>",
  "outcome": "<outcome>"
}
```

## InvocationState

Launch-ownership state of one app invocation.

Example:

```json
"queued"
```

## InvocationSummary

One app invocation, as the queue shows it.

| Field           | Description                                                           |
| --------------- | --------------------------------------------------------------------- |
| invocation_id   |                                                                       |
| state           | Launch-ownership state of one app invocation.                         |
| execution_class | `run` holds a slot, `exclusive` needs zero runs, `mutate` holds none. |
| path            | Command path, e.g. ["research"].                                      |
| position        | 1-based place in the queue, while queued.                             |
| run_id          |                                                                       |
| queued_at       |                                                                       |
| review          | Set on `needs_review`.                                                |
| result          | Set on `finished`.                                                    |

Example:

```json
{
  "invocation_id": "<invocation_id>",
  "state": "<state>",
  "execution_class": "<execution_class>",
  "path": "<path>",
  "position": "<position>",
  "run_id": "<run_id>",
  "queued_at": "<queued_at>",
  "review": "<review>",
  "result": "<result>"
}
```

## JsonResultSpec

What the command emits under --json.

| Field  | Description                                                                  |
| ------ | ---------------------------------------------------------------------------- |
| flag   | "--json" when the command registers it.                                      |
| shape  | One JSON document, newline-delimited events, an envelope, or no JSON output. |
| schema | Exported protocol schema name, or null when not yet described.               |

Example:

```json
{
  "flag": "<flag>",
  "shape": "<shape>",
  "schema": "<schema>"
}
```

## JsonRpcErrorObject

No description provided.

| Field   | Description                                                   |
| ------- | ------------------------------------------------------------- |
| code    | A JSON-RPC standard code or an app code from AppRpcErrorCode. |
| message |                                                               |
| data    | Detail of a JSON-RPC error.                                   |

Example:

```json
{
  "code": "<code>",
  "message": "<message>",
  "data": "<data>"
}
```

## JsonRpcId

Request ID; echoed unchanged in the response.

Example:

```json
"<value>"
```

## JsonRpcNotification

A host → app notification (no `id`).

| Field   | Description |
| ------- | ----------- |
| jsonrpc |             |
| method  |             |
| params  |             |

Example:

```json
{
  "jsonrpc": "<jsonrpc>",
  "method": "<method>",
  "params": "<params>"
}
```

## JsonRpcRequest

A JSON-RPC 2.0 request or notification.

| Field   | Description                                                             |
| ------- | ----------------------------------------------------------------------- |
| jsonrpc |                                                                         |
| method  | Method name, e.g. `host.hello` or `read.list`.                          |
| params  | By-name (object) parameters; by-position arrays are refused per method. |
| id      | Absent for a notification, which gets no response.                      |

Example:

```json
{
  "jsonrpc": "<jsonrpc>",
  "method": "<method>",
  "params": "<params>",
  "id": "<id>"
}
```

## JsonRpcResponse

A JSON-RPC 2.0 response.

Example:

```json
"<value>"
```

## JsonValue

Any JSON value.

Example:

```json
"<value>"
```

## KeyFinding

A scannable, citation-backed finding bullet.

| Field     | Description                                                                                                                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| actions   | Recorded action IDs backing this content.                                                                                                                                                                                                             |
| text      | Markdown text of the finding. Inline [n] markers are optional: the LLM path may emit them, while the deterministic path carries citations only in the structured citations[] array. The structured array is the single source of truth for rendering. |
| citations | Source numbers (sources[].n) backing this finding. At least one is required unless editorial is true.                                                                                                                                                 |
| editorial | True marks uncited synthesis commentary — the only legal uncited form.                                                                                                                                                                                |
| facet     | Optional structured payload (for example { price: 328, in_stock: true }), or null.                                                                                                                                                                    |
| children  | Nested child findings that elaborate this parent; one level deep only.                                                                                                                                                                                |

Example:

```json
{
  "actions": "<actions>",
  "text": "<text>",
  "citations": "<citations>",
  "editorial": "<editorial>",
  "facet": "<facet>",
  "children": "<children>"
}
```

## LLMSummarizeStep

Summarize extracted captures with an LLM.

| Field                 | Description                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| id                    | Step identifier, unique within the plan.                                                                                                |
| scope                 | Step scope; null inherits the plan default.                                                                                             |
| requires_confirmation | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, fill_element, and navigate steps. |
| type                  | LLM summarize step discriminator.                                                                                                       |
| input                 | Capture reference fed to summarization.                                                                                                 |
| prompt                | Summarization instruction prompt.                                                                                                       |
| output_as             | Capture alias for summarization output.                                                                                                 |

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

## LeafEntry

An executable command.

| Field        | Description                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| kind         |                                                                                                                                                          |
| id           | Dotted path, e.g. "config.data-dir". Equals path.join(".").                                                                                              |
| path         | Command tokens from the root.                                                                                                                            |
| description  | Help-visible description.                                                                                                                                |
| help_after   | Text added with addHelpText('after', …).                                                                                                                 |
| registration | subcommand: created with parent.command() and inherits parent settings such as showHelpAfterError; added: new Command() plus addCommand, which does not. |
| aliases      | Alternative names, e.g. "discover".                                                                                                                      |
| arguments    | Ordered positionals.                                                                                                                                     |
| options      | Ordered options and group references.                                                                                                                    |
| execution    | The execution class, possibly option-dependent.                                                                                                          |
| effect       | Maximum effect: none (read only), local (writes Yantra-owned state), external (contacts websites, providers or download servers).                        |
| danger       | Whether a generated surface must ask for explicit confirmation first.                                                                                    |
| relations    |                                                                                                                                                          |
| exit_codes   | Exit codes the command can return.                                                                                                                       |
| json         | What the command emits under --json.                                                                                                                     |

Example:

```json
{
  "kind": "<kind>",
  "id": "<id>",
  "path": "<path>",
  "description": "<description>",
  "help_after": "<help_after>",
  "registration": "<registration>",
  "aliases": "<aliases>",
  "arguments": "<arguments>",
  "options": "<options>",
  "execution": "<execution>",
  "effect": "<effect>",
  "danger": "<danger>",
  "relations": "<relations>",
  "exit_codes": "<exit_codes>",
  "json": "<json>"
}
```

## LedgerActiveRun

A run in progress: never paginated, returned on the first page only.

| Field          | Description                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| kind           |                                                                                                                                                                                                                                 |
| runId          | The run directory name.                                                                                                                                                                                                         |
| workflowName   | The workflow name, or the query or goal the run was started with.                                                                                                                                                               |
| status         | The history status or the manifest status, exactly as the CLI prints it.                                                                                                                                                        |
| startedAt      | ISO-8601 start time.                                                                                                                                                                                                            |
| durationMs     | Wall-clock duration, or null while unknown.                                                                                                                                                                                     |
| taskOutcome    | Present only on runs that recorded one.                                                                                                                                                                                         |
| executionState | `interrupted` when the run’s owner died and a reconciler ended it (FEAT-064).                                                                                                                                                   |
| taskType       | Additive (FEAT-066): the command that ran.                                                                                                                                                                                      |
| costUsd        | Additive (FEAT-066): metered cost in USD, or null when not metered.                                                                                                                                                             |
| hasDocument    | Additive (FEAT-066): the run saved a Brief or a templated document.                                                                                                                                                             |
| displayedState | queued, starting, running, waiting_for_you, needs_review (settings drift), start_outcome_unknown, worker_not_responding (no heartbeat for 30 s), or unknown_owner (the manifest says running but its owner cannot be verified). |

Example:

```json
{
  "kind": "<kind>",
  "runId": "<runId>",
  "workflowName": "<workflowName>",
  "status": "<status>",
  "startedAt": "<startedAt>",
  "durationMs": "<durationMs>",
  "taskOutcome": "<taskOutcome>",
  "executionState": "<executionState>",
  "taskType": "<taskType>",
  "costUsd": "<costUsd>",
  "hasDocument": "<hasDocument>",
  "displayedState": "<displayedState>"
}
```

## LedgerCursor

A position in `started_at DESC, run_id DESC` order.

| Field      | Description |
| ---------- | ----------- |
| v          |             |
| started_at |             |
| run_id     |             |
| source     |             |

Example:

```json
{
  "v": "<v>",
  "started_at": "<started_at>",
  "run_id": "<run_id>",
  "source": "<source>"
}
```

## LedgerDisplayedState

queued, starting, running, waiting_for_you, needs_review (settings drift), start_outcome_unknown, worker_not_responding (no heartbeat for 30 s), or unknown_owner (the manifest says running but its owner cannot be verified).

Example:

```json
"queued"
```

## LedgerMode

The command that started the run: ask, research, do, or run (a saved workflow).

Example:

```json
"ask"
```

## LedgerOutcomeFilter

No description provided.

Example:

```json
"<value>"
```

## ListResult

The `yantra list --json` document.

| Field         | Description |
| ------------- | ----------- |
| schemaVersion |             |
| kind          |             |
| items         |             |

Example:

```json
{
  "schemaVersion": "<schemaVersion>",
  "kind": "<kind>",
  "items": "<items>"
}
```

## ListRunItem

One run in `yantra list --json`.

| Field          | Description                                                                   |
| -------------- | ----------------------------------------------------------------------------- |
| kind           |                                                                               |
| runId          | The run directory name.                                                       |
| workflowName   | The workflow name, or the query or goal the run was started with.             |
| status         | The history status or the manifest status, exactly as the CLI prints it.      |
| startedAt      | ISO-8601 start time.                                                          |
| durationMs     | Wall-clock duration, or null while unknown.                                   |
| taskOutcome    | Present only on runs that recorded one.                                       |
| executionState | `interrupted` when the run’s owner died and a reconciler ended it (FEAT-064). |
| taskType       | Additive (FEAT-066): the command that ran.                                    |
| costUsd        | Additive (FEAT-066): metered cost in USD, or null when not metered.           |
| hasDocument    | Additive (FEAT-066): the run saved a Brief or a templated document.           |

Example:

```json
{
  "kind": "<kind>",
  "runId": "<runId>",
  "workflowName": "<workflowName>",
  "status": "<status>",
  "startedAt": "<startedAt>",
  "durationMs": "<durationMs>",
  "taskOutcome": "<taskOutcome>",
  "executionState": "<executionState>",
  "taskType": "<taskType>",
  "costUsd": "<costUsd>",
  "hasDocument": "<hasDocument>"
}
```

## ListWorkflowItem

One saved workflow in `yantra list workflows --json`.

| Field         | Description |
| ------------- | ----------- |
| kind          |             |
| name          |             |
| stepCount     |             |
| securityClass |             |
| modifiedAt    |             |

Example:

```json
{
  "kind": "<kind>",
  "name": "<name>",
  "stepCount": "<stepCount>",
  "securityClass": "<securityClass>",
  "modifiedAt": "<modifiedAt>"
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

## LiveItem

One declared requirement and how far the run has got with it.

| Field | Description                                                             |
| ----- | ----------------------------------------------------------------------- |
| id    | Requirement id, such as `fill:email` or `artifact:screenshot:viewport`. |
| kind  | What kind of requirement the item tracks.                               |
| label | Short human label, at most 60 characters.                               |
| state | pending (untouched), advancing (related work happened), or met.         |
| done  | Units done, or null when not counted.                                   |
| total | Units required, or null when not counted.                               |

Example:

```json
{
  "id": "<id>",
  "kind": "<kind>",
  "label": "<label>",
  "state": "<state>",
  "done": "<done>",
  "total": "<total>"
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

| Field                 | Description                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| id                    | Step identifier, unique within the plan.                                                                                                |
| scope                 | Step scope; null inherits the plan default.                                                                                             |
| requires_confirmation | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, fill_element, and navigate steps. |
| type                  | Loop step discriminator.                                                                                                                |
| over                  | Collection reference iterated by loop.                                                                                                  |
| as                    | Loop variable alias.                                                                                                                    |
| body_step_ids         | Step ids that form the loop body.                                                                                                       |
| max_iterations        | Hard cap for loop iterations at runtime.                                                                                                |

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

| Field                    | Description                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| id                       | Step identifier, unique within the plan.                                                                                                |
| scope                    | Step scope; null inherits the plan default.                                                                                             |
| requires_confirmation    | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, fill_element, and navigate steps. |
| confirmation_description | Human-readable override for the consent card. Falls back to step name when null.                                                        |
| expected_cost            | Best-effort cost estimate shown on the consent card, or null if unknown.                                                                |
| consequence              | Reversibility hint for the action, or null to default to "unknown".                                                                     |
| type                     | Navigate step discriminator.                                                                                                            |
| url                      | Target URL as a value reference.                                                                                                        |

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

## OptionGroup

A named, reusable option set.

| Field   | Description                                   |
| ------- | --------------------------------------------- |
| id      | Identifier of a named, reusable option group. |
| options | Options in registration order.                |

Example:

```json
{
  "id": "<id>",
  "options": "<options>"
}
```

## OptionGroupId

Identifier of a named, reusable option group.

Example:

```json
"agent-model"
```

## OptionRef

A reference to an option group, or an inline option.

Example:

```json
"<value>"
```

## OptionSpec

One command-line option.

| Field         | Description                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| flags         | The exact commander flags string, e.g. "-p, --params <key=value...>".                                                            |
| long          | Long flag, e.g. "--params".                                                                                                      |
| short         | Short flag, e.g. "-p".                                                                                                           |
| attribute     | Commander attribute name ("params"; "llm" for "--no-llm").                                                                       |
| value         | Whether the option takes no value, a required value or an optional value.                                                        |
| variadic      | Whether one occurrence takes several values.                                                                                     |
| negatable     | Whether this is a "--no-x" negation.                                                                                             |
| repeatable    | Whether repeated occurrences accumulate (the CLI attaches its collect parser).                                                   |
| description   | Help-visible description.                                                                                                        |
| default       | Commander parse default that help shows as "(default: …)". Absent means none. The effective default is the last precedence step. |
| mandatory     | Registered with requiredOption.                                                                                                  |
| input         | How a generated form collects this value.                                                                                        |
| precedence    | How the effective value resolves, in order.                                                                                      |
| applicability | When the option has an effect; all conditions must hold.                                                                         |
| danger        | Option-level danger, e.g. --force.                                                                                               |

Example:

```json
{
  "flags": "<flags>",
  "long": "<long>",
  "short": "<short>",
  "attribute": "<attribute>",
  "value": "<value>",
  "variadic": "<variadic>",
  "negatable": "<negatable>",
  "repeatable": "<repeatable>",
  "description": "<description>",
  "default": "<default>",
  "mandatory": "<mandatory>",
  "input": "<input>",
  "precedence": "<precedence>",
  "applicability": "<applicability>",
  "danger": "<danger>"
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

## OutputsSlot

One artifact: ok with its value, or missing, corrupt, unsupported, too large or denied.

Example:

```json
"<value>"
```

## OwnedBrowserEvent

An append-only record of a browser process the run spawned or proved exited. Readers fold the lines by identity and ignore a trailing partial line.

| Field          | Description                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------- |
| schema_version |                                                                                             |
| op             | `spawned` as soon as a browser child handle exists; `exited` only after its exit is proved. |
| pid            |                                                                                             |
| start_token    | Creation identity; `unknown` keeps the entry uncertain.                                     |
| at             |                                                                                             |

Example:

```json
{
  "schema_version": "<schema_version>",
  "op": "<op>",
  "pid": "<pid>",
  "start_token": "<start_token>",
  "at": "<at>"
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

## ParseErrorCode

No description provided.

Example:

```json
"unknown_command"
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

## PrecedenceStep

One step of the effective-value resolution chain.

Example:

```json
"<value>"
```

## PrefsChangedNotification

Preferences changed; re-read them.

Example:

```json
{}
```

## ProcessIdentityRecord

A process creation identity: a PID plus its start token.

| Field       | Description                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| pid         | Process ID.                                                                                                                                 |
| start_token | Creation identity (platform start time). `unknown` when the platform could not tell; a liveness check then answers `unknown`, never `dead`. |

Example:

```json
{
  "pid": "<pid>",
  "start_token": "<start_token>"
}
```

## QueueListResult

Every app invocation, first-in first-out.

| Field | Description |
| ----- | ----------- |
| items |             |

Example:

```json
{
  "items": "<items>"
}
```

## QueueStartParams

No description provided.

| Field                      | Description                                                            |
| -------------------------- | ---------------------------------------------------------------------- |
| invocation_id              |                                                                        |
| acknowledge_duplicate_risk | Required for an item whose earlier start is unknown: it may run twice. |

Example:

```json
{
  "invocation_id": "<invocation_id>",
  "acknowledge_duplicate_risk": "<acknowledge_duplicate_risk>"
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

## ReadListParams

No description provided.

Example:

```json
"<value>"
```

## ReadParams

Arguments of an in-process read.

| Field   | Description                                                                             |
| ------- | --------------------------------------------------------------------------------------- |
| args    | Positional arguments, exactly as on the command line.                                   |
| options | Options by long name without dashes (e.g. `{"status":"failed"}`); `true` sets a switch. |
| cursor  | Opaque cursor from a previous page’s `next_cursor` (paged reads only).                  |
| limit   | Page size (paged reads only); default 50, clamped to 200.                               |

Example:

```json
{
  "args": "<args>",
  "options": "<options>",
  "cursor": "<cursor>",
  "limit": "<limit>"
}
```

## ReadResult

The result of an in-process read.

| Field       | Description                                                                     |
| ----------- | ------------------------------------------------------------------------------- |
| schema      | The registry `--json` schema name, or null when the shape is not yet described. |
| value       | Exactly what `yantra <command> --json` prints, parsed.                          |
| next_cursor | Cursor for the next page; null on the last page or for unpaged reads.           |

Example:

```json
{
  "schema": "<schema>",
  "value": "<value>",
  "next_cursor": "<next_cursor>"
}
```

## ReceiptBrowserSelectionSchema

Browser selection at start; no profile contents or installation telemetry.

| Field     | Description                                                            |
| --------- | ---------------------------------------------------------------------- |
| selection |                                                                        |
| source    | The source of an effective non-secret setting; environment names only. |

Example:

```json
{
  "selection": "<selection>",
  "source": "<source>"
}
```

## ReceiptSettingSchema

An effective non-secret setting and its provenance.

| Field  | Description                                                            |
| ------ | ---------------------------------------------------------------------- |
| key    |                                                                        |
| value  | Any JSON value.                                                        |
| source | The source of an effective non-secret setting; environment names only. |

Example:

```json
{
  "key": "<key>",
  "value": "<value>",
  "source": "<source>"
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

## Relation

A requires/conflicts relation the CLI already enforces.

| Field  | Description                                             |
| ------ | ------------------------------------------------------- |
| kind   |                                                         |
| option | Long flag the relation constrains.                      |
| with   | Long flags it requires or conflicts with.               |
| note   | The precise enforced rule, when narrower than the kind. |

Example:

```json
{
  "kind": "<kind>",
  "option": "<option>",
  "with": "<with>",
  "note": "<note>"
}
```

## ReportResult

The `yantra report --json` document.

| Field         | Description                             |
| ------------- | --------------------------------------- |
| schemaVersion |                                         |
| kind          |                                         |
| markdown      | The run report, verbatim.               |
| truncated     | Only the head of report.md is included. |
| bytes         | The full size of report.md.             |

Example:

```json
{
  "schemaVersion": "<schemaVersion>",
  "kind": "<kind>",
  "markdown": "<markdown>",
  "truncated": "<truncated>",
  "bytes": "<bytes>"
}
```

## ReportTemplateReference

Template identity and content hash recorded with a rendered report.

| Field  | Description |
| ------ | ----------- |
| name   |             |
| source |             |
| path   |             |
| hash   |             |

Example:

```json
{
  "name": "<name>",
  "source": "<source>",
  "path": "<path>",
  "hash": "<hash>"
}
```

## RoleEnum

Supported ARIA role intents. Must stay a subset of the roles the locator engine can compute (`getRole`), or a recorded role can never match at replay: `<select>` computes `listbox`, `input[type=search]` computes `searchbox`, and `input[type=number|date|time|month|week]` computes `spinbutton`.

Example:

```json
"button"
```

## RunArtifactExposure

typed: only through a typed read (e.g. brief.json through read.run_result); view: through a bounded viewer; download: only as an attachment; denied: never served.

Example:

```json
"typed"
```

## RunArtifactRegistry

The public run-artifact allowlist, in match order.

Example:

```json
"<value>"
```

## RunArtifactRegistryEntry

One entry of the public run-artifact allowlist.

| Field            | Description                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id               | Stable entry name, e.g. `brief.json` or `screenshots`.                                                                                                             |
| pattern          | Run-relative, forward-slash glob (`*` within a segment, `**` across segments).                                                                                     |
| exposure         | typed: only through a typed read (e.g. brief.json through read.run_result); view: through a bounded viewer; download: only as an attachment; denied: never served. |
| viewer           | The bounded viewer that opens the file; `none` when no viewer exists.                                                                                              |
| media_type       | The only Content-Type the host may send for the entry.                                                                                                             |
| inline_cap_bytes | Largest file a viewer may load whole; above it the item is too_large. Null: windowed, or never loaded inline.                                                      |
| description      | What the file is, for generated docs and parity.                                                                                                                   |

Example:

```json
{
  "id": "<id>",
  "pattern": "<pattern>",
  "exposure": "<exposure>",
  "viewer": "<viewer>",
  "media_type": "<media_type>",
  "inline_cap_bytes": "<inline_cap_bytes>",
  "description": "<description>"
}
```

## RunArtifactViewer

The bounded viewer that opens the file; `none` when no viewer exists.

Example:

```json
"brief"
```

## RunChannelClientMessage

A run-channel message from a client to the run owner.

Example:

```json
"<value>"
```

## RunChannelEventPayload

A RunEvent, or an event of a kind this executable does not know.

Example:

```json
"<value>"
```

## RunChannelMessage

A run-channel JSON message (frame type 0x01), in either direction.

Example:

```json
"<value>"
```

## RunChannelServerMessage

A run-channel message from the run owner to a client.

Example:

```json
"<value>"
```

## RunEvent

One run event, discriminated by `kind`.

Example:

```json
"<value>"
```

## RunEventRecord

One sequence-numbered run event, as written to run-events.jsonl.

| Field          | Description                                                            |
| -------------- | ---------------------------------------------------------------------- |
| schema_version | Envelope version; a reader rejects an unknown major.                   |
| seq            | Gap-free, strictly increasing sequence number, assigned by the writer. |
| run_id         | The owning run.                                                        |
| event          | One run event, discriminated by `kind`.                                |

Example:

```json
{
  "schema_version": "<schema_version>",
  "seq": "<seq>",
  "run_id": "<run_id>",
  "event": "<event>"
}
```

## RunHealth

An agentic run's own health summary (run-health.json): searches, fetches, source failures, browser launches, budgets, tool failures, and runtime notices. Counts and closed codes only.

| Field           | Description                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------- |
| schema_version  | Run-health schema version.                                                                  |
| run_id          | Owning run id.                                                                              |
| searches        | Web searches by outcome.                                                                    |
| fetches         | Network page fetches.                                                                       |
| source_failures | Per-site read failures inside multi-source tools, by stage.                                 |
| browser         | Browser processes.                                                                          |
| budgets         | Run budget consumption.                                                                     |
| tool_failures   | Tool failures across every tool.                                                            |
| progress        | Semantic progress, recovery and turn telemetry; absent on older runs.                       |
| notices         | Runtime-derived notices attached to the published document; 0 when nothing was published.   |
| extraction      | Shape-aware extraction (FEAT-051): pages by shape, records, and links.                      |
| capture         | Both capture capabilities with reason codes, and what deliverable capture wrote (FEAT-058). |

Example:

```json
{
  "schema_version": "<schema_version>",
  "run_id": "<run_id>",
  "searches": "<searches>",
  "fetches": "<fetches>",
  "source_failures": "<source_failures>",
  "browser": "<browser>",
  "budgets": "<budgets>",
  "tool_failures": "<tool_failures>",
  "progress": "<progress>",
  "notices": "<notices>",
  "extraction": "<extraction>",
  "capture": "<capture>"
}
```

## RunHealthSlot

One artifact: ok with its value, or missing, corrupt, unsupported, too large or denied.

Example:

```json
"<value>"
```

## RunId

A run id, e.g. `20260511T091234Z-bank-statement-a7b3`; names `runs/<run_id>/`.

Example:

```json
"<value>"
```

## RunLease

Exclusive ownership of a run directory, written once by `link` and removed only after the terminal event and manifest are flushed. Owner-only file.

| Field            | Description                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| schema_version   | Lease envelope version.                                                                                                                   |
| run_id           | The owned run; equals the run directory name.                                                                                             |
| owner            | Creation identity of the owning process.                                                                                                  |
| origin           | Who launched the run: a terminal command, a detached app worker, or the daemon.                                                           |
| execution_class  | The command registry's execution class for the invocation (normally `run`).                                                               |
| command          | Command path, for example `["research"]`. Display only.                                                                                   |
| socket           | The run socket address: a Unix socket in an owner-only directory, or a named pipe.                                                        |
| run_token        | Secret that authenticates run-socket clients (32 random bytes, base64url). Never logged, never sent to the model or served to the app.    |
| channel_version  | Highest run-channel version the owner speaks (D17).                                                                                       |
| yantra_version   | Version of the Yantra executable that owns the run.                                                                                       |
| log_seq_at_claim | Last committed `run-events.jsonl` seq at claim: the start of this ownership epoch. A reconciler looks for a terminal event only above it. |
| claimed_at       | When the lease was claimed.                                                                                                               |

Example:

```json
{
  "schema_version": "<schema_version>",
  "run_id": "<run_id>",
  "owner": "<owner>",
  "origin": "<origin>",
  "execution_class": "<execution_class>",
  "command": "<command>",
  "socket": "<socket>",
  "run_token": "<run_token>",
  "channel_version": "<channel_version>",
  "yantra_version": "<yantra_version>",
  "log_seq_at_claim": "<log_seq_at_claim>",
  "claimed_at": "<claimed_at>"
}
```

## RunLeaseOrigin

Who launched the run: a terminal command, a detached app worker, or the daemon.

Example:

```json
"terminal"
```

## RunLedgerPage

One Ledger page.

| Field          | Description                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| schemaVersion  |                                                                              |
| kind           |                                                                              |
| items          |                                                                              |
| next_cursor    | Cursor for the next page; null on the last page.                             |
| source         | `files` when the history index was unavailable and runs were read from disk. |
| scan_truncated | File fallback only: the scan stopped at its directory cap.                   |
| active         | Runs in progress (first page only).                                          |

Example:

```json
{
  "schemaVersion": "<schemaVersion>",
  "kind": "<kind>",
  "items": "<items>",
  "next_cursor": "<next_cursor>",
  "source": "<source>",
  "scan_truncated": "<scan_truncated>",
  "active": "<active>"
}
```

## RunLedgerQuery

One Ledger page request.

| Field    | Description                                                  |
| -------- | ------------------------------------------------------------ |
| target   |                                                              |
| cursor   | Opaque cursor from a previous page’s `next_cursor`.          |
| limit    | Page size, 1–200 (default 50).                               |
| outcome  | Only these outcomes; `unknown` matches runs without one.     |
| mode     | Only these commands.                                         |
| since    | Only runs started at or after this instant.                  |
| until    | Only runs started before this instant.                       |
| text     | Case-insensitive substring of the intent text or the run id. |
| workflow | `yantra list --workflow`: exact name.                        |
| status   | `yantra list --status`: exact status word.                   |

Example:

```json
{
  "target": "<target>",
  "cursor": "<cursor>",
  "limit": "<limit>",
  "outcome": "<outcome>",
  "mode": "<mode>",
  "since": "<since>",
  "until": "<until>",
  "text": "<text>",
  "workflow": "<workflow>",
  "status": "<status>"
}
```

## RunRelativePath

Run-relative POSIX path of a file inside the run directory.

Example:

```json
"<value>"
```

## RunResultParams

No description provided.

| Field  | Description                                                                    |
| ------ | ------------------------------------------------------------------------------ |
| run_id | A run id, e.g. `20260511T091234Z-bank-statement-a7b3`; names `runs/<run_id>/`. |

Example:

```json
{
  "run_id": "<run_id>"
}
```

## RunResultView

One run, read for the app’s Run result page.

| Field               | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| run_id              | A run id, e.g. `20260511T091234Z-bank-statement-a7b3`; names `runs/<run_id>/`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| mode                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| title               | Document title, else the intent or query, else the workflow name.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| started_at          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ended_at            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| duration_ms         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| status              | The manifest status as the CLI prints it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| task_outcome        | Whether the task was done: fulfilled (every declared requirement met), partial (a result was saved but a requirement is unmet or no contract was declared), handoff (the run needs the user), failed (nothing usable was saved), or aborted (the user interrupted).                                                                                                                                                                                                                                        |
| termination_reason  | Why the run stopped: stalled (no progress after recovery), turn-timeout (thinking limit), the model finished, a budget or the repeated-failure breaker ended it, a handoff was raised, the user aborted, or the provider failed. wall-clock-soft means the model finished after the exploration wind-down began. owner_lost means the process that owned the run died before writing a terminal result, and a reconciler recorded the end (FEAT-064). Added in FEAT-063: readable by new executables only. |
| execution_state     | Set only by the reconciler when the owning process died before writing a terminal result (plan D7). Separate from the outcome, which follows the evidence and is never `aborted`. Absent for every run that ended on its own.                                                                                                                                                                                                                                                                              |
| live                | Present only while the run has not ended; unknown_owner when its owner cannot be verified.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| document            | The Brief or templated document, or none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| outputs             | A workflow run’s outputs.json; null for other runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| terminal            | Why the run ended; every text bounded to 500 characters.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| run_health          | One artifact: ok with its value, or missing, corrupt, unsupported, too large or denied.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| report              | report.md; its body is read lazily through read.report.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| artifacts           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| artifacts_truncated |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| notices_source      | Where the Notices block comes from.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Example:

```json
{
  "run_id": "<run_id>",
  "mode": "<mode>",
  "title": "<title>",
  "started_at": "<started_at>",
  "ended_at": "<ended_at>",
  "duration_ms": "<duration_ms>",
  "status": "<status>",
  "task_outcome": "<task_outcome>",
  "termination_reason": "<termination_reason>",
  "execution_state": "<execution_state>",
  "live": "<live>",
  "document": "<document>",
  "outputs": "<outputs>",
  "terminal": "<terminal>",
  "run_health": "<run_health>",
  "report": "<report>",
  "artifacts": "<artifacts>",
  "artifacts_truncated": "<artifacts_truncated>",
  "notices_source": "<notices_source>"
}
```

## RunSocketAddress

The run socket address: a Unix socket in an owner-only directory, or a named pipe.

Example:

```json
"<value>"
```

## RunSubscribeParams

No description provided.

| Field    | Description                                             |
| -------- | ------------------------------------------------------- |
| run_id   | The run to follow.                                      |
| from_seq | First event seq wanted; earlier ones are already shown. |

Example:

```json
{
  "run_id": "<run_id>",
  "from_seq": "<from_seq>"
}
```

## RunSubscribeResult

No description provided.

| Field   | Description                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| channel | `live`: replay then live; `replay_only`: the run has no live owner; `live_unavailable`: the owner speaks another channel version. |

Example:

```json
{
  "channel": "<channel>"
}
```

## RunUnsubscribeParams

No description provided.

| Field  | Description |
| ------ | ----------- |
| run_id |             |

Example:

```json
{
  "run_id": "<run_id>"
}
```

## RunsChangedNotification

Runs appeared, changed or ended; re-read what is shown.

| Field        | Description                                                                  |
| ------------ | ---------------------------------------------------------------------------- |
| run_ids      | Runs known to have changed; empty when the index changed without naming one. |
| live_run_ids | Runs with a lease right now.                                                 |

Example:

```json
{
  "run_ids": "<run_ids>",
  "live_run_ids": "<live_run_ids>"
}
```

## RunsSubscribeResult

Subscribed to run and preference changes.

| Field        | Description                  |
| ------------ | ---------------------------- |
| live_run_ids | Runs with a lease right now. |

Example:

```json
{
  "live_run_ids": "<live_run_ids>"
}
```

## ScalarValue

Scalar value for task params.

Example:

```json
"<value>"
```

## ScreenshotArtifactPath

Run-relative path of the artifact file, using forward slashes.

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

| Field     | Description                                                     |
| --------- | --------------------------------------------------------------- |
| actions   | Recorded action IDs backing this content.                       |
| kind      | Labels off-contract alternatives; absent for ordinary sections. |
| heading   | Section heading.                                                |
| body_md   | Markdown body prose; must not contain raw ANSI escapes.         |
| citations | Source numbers (sources[].n) cited by this section.             |

Example:

```json
{
  "actions": "<actions>",
  "kind": "<kind>",
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

## SessionCodeResult

No description provided.

| Field      | Description                                                  |
| ---------- | ------------------------------------------------------------ |
| code       | Single-use code, valid for 60 seconds, bound to this window. |
| expires_at |                                                              |

Example:

```json
{
  "code": "<code>",
  "expires_at": "<expires_at>"
}
```

## SessionGrantResponse

A window session; the capability is kept in memory only.

| Field             | Description |
| ----------------- | ----------- |
| window_id         |             |
| window_capability |             |
| build_id          |             |
| absolute_expiry   |             |

Example:

```json
{
  "window_id": "<window_id>",
  "window_capability": "<window_capability>",
  "build_id": "<build_id>",
  "absolute_expiry": "<absolute_expiry>"
}
```

## SettingSourceSchema

The source of an effective non-secret setting; environment names only.

Example:

```json
"<value>"
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

## TaskContractBody

A normalized task contract: the deliverable, required fields, filters, and required sources a run declared for the user's goal.

| Field            | Description                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deliverable      | What the run delivers: rows of fields, a direct answer, a prose report, or page actions (state changed or captured) with a Brief of what was done.                         |
| subject          | What the rows or the answer are about.                                                                                                                                     |
| required_fields  | Fields each row or answer must carry, unique case-insensitively. Non-empty for a table.                                                                                    |
| filters          | Every condition the goal states, with names unique case-insensitively.                                                                                                     |
| required_sources | Normalized hostnames of sites the goal names (lowercase; no scheme, path, port, or leading www.). Unique. For an actions deliverable, the host the actions must happen on. |
| ranking          | How results are ordered, when the goal asks for an order.                                                                                                                  |
| limit            | How many results the goal asks for, when it says.                                                                                                                          |
| notes            | Anything the structure cannot express, such as a site named without its address.                                                                                           |
| fill             | Which form fields the goal asks to fill, or null when it asks for none.                                                                                                    |
| artifacts        | Artifacts the goal asks for, such as a screenshot; unique by kind and scope.                                                                                               |
| effects          | Side effects the goal permits; submit defaults to allowed.                                                                                                                 |

Example:

```json
{
  "deliverable": "<deliverable>",
  "subject": "<subject>",
  "required_fields": "<required_fields>",
  "filters": "<filters>",
  "required_sources": "<required_sources>",
  "ranking": "<ranking>",
  "limit": "<limit>",
  "notes": "<notes>",
  "fill": "<fill>",
  "artifacts": "<artifacts>",
  "effects": "<effects>"
}
```

## TaskContractRecord

The task contract an agentic research/do run declared (contract.json): every revision in declaration order, the last being current. Sanitized, model-authored, and never a source of authority.

| Field          | Description                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| schema_version | Task-contract schema version.                                                                                                                                                    |
| run_id         | Owning run id.                                                                                                                                                                   |
| command        | The agentic command that declared the contract.                                                                                                                                  |
| revisions      | Declarations in order; the last one is the current contract.                                                                                                                     |
| requirements   | Action requirements (fill, artifacts, effects) in force across every revision, each with the revision that declared it. A later revision cannot drop one. Absent on older files. |

Example:

```json
{
  "schema_version": "<schema_version>",
  "run_id": "<run_id>",
  "command": "<command>",
  "revisions": "<revisions>",
  "requirements": "<requirements>"
}
```

## TaskEvent

Discriminated union for task lifecycle events.

Example:

```json
"<value>"
```

## TaskOutcome

Whether the task was done: fulfilled (every declared requirement met), partial (a result was saved but a requirement is unmet or no contract was declared), handoff (the run needs the user), failed (nothing usable was saved), or aborted (the user interrupted).

Example:

```json
"fulfilled"
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

## TemplateManifest

Validated slot manifest produced from a report template.

| Field       | Description                                                                    |
| ----------- | ------------------------------------------------------------------------------ |
| name        | Normalized template name, or null when frontmatter omits it.                   |
| description | One-line author description, or null.                                          |
| guidance    | Optional document-level author guidance appended to the model schema, or null. |
| tags        | Normalized, deduplicated, sorted template tags.                                |
| slots       | Slots in declaration order.                                                    |
| body        | Markdown below YAML frontmatter, retained verbatim.                            |
| hash        | SHA-256 of the complete raw template text.                                     |

Example:

```json
{
  "name": "<name>",
  "description": "<description>",
  "guidance": "<guidance>",
  "tags": "<tags>",
  "slots": "<slots>",
  "body": "<body>",
  "hash": "<hash>"
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

## TemplateSlot

A validated placeholder declaration and its render location.

| Field       | Description                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------- |
| key         | Unique model-facing slot key.                                                                       |
| kind        | Value shape rendered into this placeholder.                                                         |
| headingPath | Enclosing ATX headings, outermost first, used as the model description.                             |
| columns     | Table column labels, or null for non-table slots.                                                   |
| constraints | Optional character, word, item, or row bounds declared on a slot.                                   |
| guidance    | Optional author guidance appended to this slot's model description, or null.                        |
| offset      | Character offset of the opening placeholder in manifest.body after guidance directives are removed. |

Example:

```json
{
  "key": "<key>",
  "kind": "<kind>",
  "headingPath": "<headingPath>",
  "columns": "<columns>",
  "constraints": "<constraints>",
  "guidance": "<guidance>",
  "offset": "<offset>"
}
```

## TemplateSlotConstraints

Optional character, word, item, or row bounds declared on a slot.

| Field    | Description |
| -------- | ----------- |
| minChars |             |
| maxChars |             |
| minWords |             |
| maxWords |             |
| min      |             |
| max      |             |

Example:

```json
{
  "minChars": "<minChars>",
  "maxChars": "<maxChars>",
  "minWords": "<minWords>",
  "maxWords": "<maxWords>",
  "min": "<min>",
  "max": "<max>"
}
```

## TemplateSlotKind

No description provided.

Example:

```json
"text"
```

## TemplateSlotValue

No description provided.

Example:

```json
"<value>"
```

## TemplatedReport

A runtime-rendered report backed by a user-authored Markdown template.

| Field          | Description                                                         |
| -------------- | ------------------------------------------------------------------- |
| report_id      | Unique report document id (ULID).                                   |
| task_id        | Originating task id (ULID).                                         |
| schema_version |                                                                     |
| template       | Template identity and content hash recorded with a rendered report. |
| title          | Display title used by history and HTML.                             |
| slots          | Validated model-filled slot values.                                 |
| rendered_md    | Canonical Markdown rendered by the runtime.                         |
| sources        | Engine-owned evidence ledger sources.                               |
| metadata       | Reused Brief provenance and usage metadata.                         |
| notices        | Reused Brief notices.                                               |

Example:

```json
{
  "report_id": "<report_id>",
  "task_id": "<task_id>",
  "schema_version": "<schema_version>",
  "template": "<template>",
  "title": "<title>",
  "slots": "<slots>",
  "rendered_md": "<rendered_md>",
  "sources": "<sources>",
  "metadata": "<metadata>",
  "notices": "<notices>"
}
```

## TemplatedReportSlot

One artifact: ok with its value, or missing, corrupt, unsupported, too large or denied.

Example:

```json
"<value>"
```

## TerminalReason

Why the run ended; every text bounded to 500 characters.

| Field              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| source             | Which reader answered: the run-event stream, manifest, events.jsonl or report.md.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| failure_class      | The failure category, verbatim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| message            | What happened, ANSI-stripped and bounded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| blocker            | What blocked the run, for a handoff.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| safest_next_action | The one next step the run recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| termination_reason | Why the run stopped: stalled (no progress after recovery), turn-timeout (thinking limit), the model finished, a budget or the repeated-failure breaker ended it, a handoff was raised, the user aborted, or the provider failed. wall-clock-soft means the model finished after the exploration wind-down began. owner_lost means the process that owned the run died before writing a terminal result, and a reconciler recorded the end (FEAT-064). Added in FEAT-063: readable by new executables only. |

Example:

```json
{
  "source": "<source>",
  "failure_class": "<failure_class>",
  "message": "<message>",
  "blocker": "<blocker>",
  "safest_next_action": "<safest_next_action>",
  "termination_reason": "<termination_reason>"
}
```

## TerminationReason

Why the run stopped: stalled (no progress after recovery), turn-timeout (thinking limit), the model finished, a budget or the repeated-failure breaker ended it, a handoff was raised, the user aborted, or the provider failed. wall-clock-soft means the model finished after the exploration wind-down began. owner_lost means the process that owned the run died before writing a terminal result, and a reconciler recorded the end (FEAT-064). Added in FEAT-063: readable by new executables only.

Example:

```json
"model_finished"
```

## ToolAuditEntry

Stable append-only tool lifecycle entry stored in tool-calls.jsonl.

| Field            | Description                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| actions          | Run-wide action IDs recorded by this successful tool call.                                                                   |
| ts               | ISO-8601 UTC timestamp for this lifecycle phase.                                                                             |
| seq              | Monotonic sequence number within the run.                                                                                    |
| run_id           | Owning Yantra run identifier.                                                                                                |
| session_id       | Owning provider session identifier.                                                                                          |
| call_id          | Provider tool-call identifier pairing start and end.                                                                         |
| tool             | Stable registered tool name.                                                                                                 |
| phase            | Tool-call lifecycle phase.                                                                                                   |
| input_sanitized  | Sanitized tool input, or null on end entries.                                                                                |
| output_sanitized | Sanitized tool output, or null on start entries.                                                                             |
| status           | Terminal tool status, or null on start entries.                                                                              |
| duration_ms      | Elapsed tool time in milliseconds, or null on start entries.                                                                 |
| error_code       | Stable error code when present, otherwise null.                                                                              |
| confirmation_id  | Linked confirmation identifier when present, otherwise null.                                                                 |
| captures         | Legacy Vision Assist capture metadata written before FEAT-058; read through artifactRefsOf. Never image bytes or a data URI. |
| artifacts        | Files this call wrote to the run directory (FEAT-058); metadata only, never image bytes or a data URI.                       |

Example:

```json
{
  "actions": "<actions>",
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
  "confirmation_id": "<confirmation_id>",
  "captures": "<captures>",
  "artifacts": "<artifacts>"
}
```

## UiOpenResult

What `yantra ui` opened or printed.

| Field         | Description                                                  |
| ------------- | ------------------------------------------------------------ |
| schemaVersion | Output format version.                                       |
| url           | The app URL with its single-use launch code in the fragment. |
| port          | Loopback HTTP port.                                          |
| hostPid       | App host process ID.                                         |
| reused        | True when an already-running host served the request.        |

Example:

```json
{
  "schemaVersion": "<schemaVersion>",
  "url": "<url>",
  "port": "<port>",
  "hostPid": "<hostPid>",
  "reused": "<reused>"
}
```

## UsageCall

Single LLM usage call record.

| Field             | Description                                               |
| ----------------- | --------------------------------------------------------- |
| step_id           | Owning step id, null for plan-generation calls.           |
| model             | Model identifier.                                         |
| provider          | Provider identifier.                                      |
| input_tokens      | Input token count.                                        |
| output_tokens     | Output token count.                                       |
| cost_estimate_usd | Nullable estimated cost in USD.                           |
| reasoning_tokens  | Reasoning tokens (a subset of output), when reported.     |
| thinking_ms       | Turn start to first output, excluding tool time.          |
| provider_ms       | Turn start to assistant message end, excluding tool time. |
| latency_ms        | Call latency in milliseconds.                             |
| at                | ISO-8601 UTC timestamp.                                   |

Example:

```json
{
  "step_id": "<step_id>",
  "model": "<model>",
  "provider": "<provider>",
  "input_tokens": "<input_tokens>",
  "output_tokens": "<output_tokens>",
  "cost_estimate_usd": "<cost_estimate_usd>",
  "reasoning_tokens": "<reasoning_tokens>",
  "thinking_ms": "<thinking_ms>",
  "provider_ms": "<provider_ms>",
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

Provider registry name used for the model call (for example `anthropic`, `ollama`, `groq`).

Example:

```json
"<value>"
```

## ValueRef

No description provided.

Example:

```json
"<value>"
```

## VisionAssistCapability

Whether Vision Assist (screenshots sent to the model) is available, and why not.

| Field     | Description                                                      |
| --------- | ---------------------------------------------------------------- |
| available | Whether the capability is registered for this run.               |
| reasons   | Every condition that keeps it off; empty exactly when available. |

Example:

```json
{
  "available": "<available>",
  "reasons": "<reasons>"
}
```

## VisionAssistReason

A condition that keeps Vision Assist off.

Example:

```json
"grant_missing"
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

| Field                 | Description                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| id                    | Step identifier, unique within the plan.                                                                                                |
| scope                 | Step scope; null inherits the plan default.                                                                                             |
| requires_confirmation | If true, the executor pauses for human consent before executing this step. Only legal on click, fill, fill_element, and navigate steps. |
| type                  | Wait-for step discriminator.                                                                                                            |
| locator               | Locator chain for awaited target.                                                                                                       |
| state                 | Target state to wait for.                                                                                                               |
| timeout_ms            | Optional timeout override.                                                                                                              |

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

## WorkerExecutionClass

`run` holds a slot, `exclusive` needs zero runs, `mutate` holds none.

Example:

```json
"run"
```

## WorkerLaunch

What a detached worker runs. Owner-only, exclusively created; user text never reaches the worker argv.

| Field          | Description                                             |
| -------------- | ------------------------------------------------------- |
| schema_version |                                                         |
| invocation     | A requested command invocation.                         |
| run_id         | Run ID preallocated by the host slot reservation (D11). |
| result_path    | Where the worker writes its WorkerResult, once.         |

Example:

```json
{
  "schema_version": "<schema_version>",
  "invocation": "<invocation>",
  "run_id": "<run_id>",
  "result_path": "<result_path>"
}
```

## WorkerResult

A detached worker's completion: the command's result or error, written once.

| Field          | Description                                                     |
| -------------- | --------------------------------------------------------------- |
| schema_version |                                                                 |
| invocation_id  |                                                                 |
| run_id         |                                                                 |
| outcome        | The final completion of a command executed on a worker surface. |

Example:

```json
{
  "schema_version": "<schema_version>",
  "invocation_id": "<invocation_id>",
  "run_id": "<run_id>",
  "outcome": "<outcome>"
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

## WorkflowListQuery

List saved workflows.

| Field  | Description |
| ------ | ----------- |
| target |             |

Example:

```json
{
  "target": "<target>"
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
