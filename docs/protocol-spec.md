# Protocol Spec

> DO NOT EDIT - regenerated from packages/protocol

## AssertCondition

Assertion condition payload.

Example:

```json
"<value>"
```

## AssertStep

Assert state against the current page.

| Field     | Description                                 |
| --------- | ------------------------------------------- |
| id        | Step identifier, unique within the plan.    |
| scope     | Step scope; null inherits the plan default. |
| type      | Assert step discriminator.                  |
| locator   | Locator chain for assertion target.         |
| condition | Assertion condition payload.                |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
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

| Field        | Description                                 |
| ------------ | ------------------------------------------- |
| id           | Step identifier, unique within the plan.    |
| scope        | Step scope; null inherits the plan default. |
| type         | Branch step discriminator.                  |
| condition    | Branch condition payload.                   |
| then_step_id | Step id for true branch.                    |
| else_step_id | Optional step id for false branch.          |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
  "type": "<type>",
  "condition": "<condition>",
  "then_step_id": "<then_step_id>",
  "else_step_id": "<else_step_id>"
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

## CallWorkflowStep

Invoke another workflow from the current plan.

| Field         | Description                                 |
| ------------- | ------------------------------------------- |
| id            | Step identifier, unique within the plan.    |
| scope         | Step scope; null inherits the plan default. |
| type          | Call-workflow step discriminator.           |
| workflow_name | Name of workflow to invoke.                 |
| params        | Param values passed to called workflow.     |
| capture_as    | Optional capture alias for workflow output. |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
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

| Field     | Description                                 |
| --------- | ------------------------------------------- |
| id        | Step identifier, unique within the plan.    |
| scope     | Step scope; null inherits the plan default. |
| type      | Click step discriminator.                   |
| locator   | Locator chain for click target.             |
| modifiers | Optional click modifier keys.               |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
  "type": "<type>",
  "locator": "<locator>",
  "modifiers": "<modifiers>"
}
```

## ExtractStep

Extract data from the page using a declared schema.

| Field             | Description                                 |
| ----------------- | ------------------------------------------- |
| id                | Step identifier, unique within the plan.    |
| scope             | Step scope; null inherits the plan default. |
| type              | Extract step discriminator.                 |
| locator           | Locator chain for extraction target.        |
| extraction_schema | Expected extracted data shape.              |
| capture_as        | Capture alias for downstream references.    |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
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

Example:

```json
"<value>"
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

## FillStep

Fill an input-like field.

| Field   | Description                                 |
| ------- | ------------------------------------------- |
| id      | Step identifier, unique within the plan.    |
| scope   | Step scope; null inherits the plan default. |
| type    | Fill step discriminator.                    |
| locator | Locator chain for fill target.              |
| value   | Value inserted into the target input.       |
| submit  | Whether to submit after filling.            |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
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

## LLMSummarizeStep

Summarize extracted captures with an LLM.

| Field     | Description                                 |
| --------- | ------------------------------------------- |
| id        | Step identifier, unique within the plan.    |
| scope     | Step scope; null inherits the plan default. |
| type      | LLM summarize step discriminator.           |
| input     | Capture reference fed to summarization.     |
| prompt    | Summarization instruction prompt.           |
| output_as | Capture alias for summarization output.     |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
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

| Field          | Description                                 |
| -------------- | ------------------------------------------- |
| id             | Step identifier, unique within the plan.    |
| scope          | Step scope; null inherits the plan default. |
| type           | Loop step discriminator.                    |
| over           | Collection reference iterated by loop.      |
| as             | Loop variable alias.                        |
| body_step_ids  | Step ids that form the loop body.           |
| max_iterations | Hard cap for loop iterations at runtime.    |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
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

## NavigateStep

Navigate browser to a URL.

| Field | Description                                 |
| ----- | ------------------------------------------- |
| id    | Step identifier, unique within the plan.    |
| scope | Step scope; null inherits the plan default. |
| type  | Navigate step discriminator.                |
| url   | Target URL as a value reference.            |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
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

| Field          | Description                                    |
| -------------- | ---------------------------------------------- |
| task_id        | Owning task id.                                |
| plan_id        | Unique plan id.                                |
| schema_version | Protocol schema version literal.               |
| default_scope  | Default scope applied when step scope is null. |
| steps          | Ordered finite list of plan steps.             |
| outputs        | Optional plan outputs.                         |

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

Supported ARIA role intents.

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

| Field | Description                          |
| ----- | ------------------------------------ |
| kind  | Discriminator for secret references. |
| key   | Secret key in namespace.name format. |

Example:

```json
{
  "kind": "<kind>",
  "key": "<key>"
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

## TaskEvent

Discriminated union for task lifecycle events.

Example:

```json
"<value>"
```

## TaskRequest

Top-level task request entering the agent/executor pipeline.

| Field          | Description                                               |
| -------------- | --------------------------------------------------------- |
| task_id        | Task identifier in ULID format.                           |
| type           | Task type in MVP.                                         |
| intent         | User-provided intent statement.                           |
| params         | Runtime parameters for task execution.                    |
| data_refs      | Optional explicit secret references required by the task. |
| deadline_ms    | Optional overall deadline in milliseconds.                |
| budget         | Optional execution budget constraints.                    |
| security_class | Security class for the task.                              |
| schema_version | Protocol schema version literal.                          |

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

| Field  | Description                 |
| ------ | --------------------------- |
| run_id | Owning run id.              |
| calls  | Chronological call records. |
| totals | Aggregated usage totals.    |

Example:

```json
{
  "run_id": "<run_id>",
  "calls": "<calls>",
  "totals": "<totals>"
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

## WaitForStep

Wait for target element state transitions.

| Field      | Description                                 |
| ---------- | ------------------------------------------- |
| id         | Step identifier, unique within the plan.    |
| scope      | Step scope; null inherits the plan default. |
| type       | Wait-for step discriminator.                |
| locator    | Locator chain for awaited target.           |
| state      | Target state to wait for.                   |
| timeout_ms | Optional timeout override.                  |

Example:

```json
{
  "id": "<id>",
  "scope": "<scope>",
  "type": "<type>",
  "locator": "<locator>",
  "state": "<state>",
  "timeout_ms": "<timeout_ms>"
}
```

## WorkflowFile

Workflow YAML schema source used by parser, linter, and editor integrations.

| Field               | Description                                           |
| ------------------- | ----------------------------------------------------- |
| version             | Workflow format major version.                        |
| name                | Workflow slug name.                                   |
| description         | Optional workflow description.                        |
| security_class      | Workflow security class.                              |
| recorded_with       | Optional recording metadata.                          |
| params              | Workflow parameter declarations.                      |
| secrets             | Declared workflow secret keys.                        |
| cookies             | Cookie/profile handling mode.                         |
| steps               | Ordered workflow steps.                               |
| outputs             | Workflow output declarations.                         |
| outputs_unredacted  | Whether outputs bypass redaction safeguards.          |
| \_unrecorded_frames | Cross-origin frames not instrumented at record time.  |
| \_locators          | Named locator chains captured or authored for replay. |

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

## WorkflowValueExpression

Workflow value expression or scalar literal.

Example:

```json
"<value>"
```
