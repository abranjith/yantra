# Run Artifacts

Every Yantra run — deterministic replay or agentic — produces one
self-contained directory under `<yantra-data-dir>/runs/<run-id>/`. The run
directory is the canonical observability artifact: no telemetry leaves your
machine, and `yantra audit <run-id>` renders the trail from these files.

Agentic commands allocate this directory and write the initial manifest
**before** resolving the provider, model, or credentials. Failed startups are
runs too: `manifest.json` retains whatever safe agent metadata was resolved,
stores the typed startup error, `events.jsonl` receives `task_failed`, and
`report.md` explains the failure. Retries continue to use that same run
identity, so a failed attempt never creates an orphan second directory.

## Agentic run layout (plan `plan_agentic.md` §7)

```text
runs/<run-id>/
  manifest.json          # run metadata, incl. the agent section (model, auth_source, session pointer)
  events.jsonl           # Yantra task events
  agent/
    <pi-session>.jsonl   # the raw provider session (canonical conversation artifact)
  tool-calls.jsonl       # stable Yantra tool audit projection
  usage.json             # aggregated usage
  captures/              # oversized sanitized browser/web extraction payloads
  trace.json             # ordered successful browser interactions (promotion source)
  ...
```

Large `browser_extract` results are written as restrictive-permission JSON
files under `captures/`; the model receives only a bounded preview and opaque
`capture_ref`. Capture references are run-local and do not reveal filesystem
paths to the model.

`trace.json` records the ordered successful browser interactions of the run
(navigate/click/fill/extract). Each interactive step carries a **candidate-chain
locator** derived from the observation's role/name — never an opaque `eN` ref —
and a fill performed with a website secret records only the `SecretRef` **key**,
never the resolved value. It is the source material for `yantra do --save-as`,
which promotes it into a saved, replayable workflow.

## The provider session file

The agent provider session (a Pi JSONL conversation log) is **created
directly under `runs/<run-id>/agent/`** — the pinned SDK supports placing a
new session at an arbitrary directory, so no staging or relocate-on-close
step is involved and `manifest.json` always points at the file's final home.
(The plan reserved a relocate-on-close fallback in case direct placement was
unsupported; it is not needed at the pinned SDK version.)

Notes:

- The session file is written lazily by the SDK; if a run fails before the
  first assistant message, Yantra still finalizes a readable session file
  containing the session header, so the manifest pointer is always valid.
- Raw provider sessions are sensitive local artifacts. They inherit the run
  directory's restrictive permissions (`0o700` directory, `0o600` file;
  best-effort on Windows).
- The manifest stores a relative session path, so run directories remain
  movable.

## Agent manifest metadata

The `agent` object in `manifest.json` is the stable pointer and provenance
record for the provider session:

| Field               | Meaning                                                         |
| ------------------- | --------------------------------------------------------------- |
| `adapter`           | The provider adapter (`pi-coding-agent`).                       |
| `sdk_version`       | Installed SDK version resolved at runtime.                      |
| `provider`, `model` | Effective provider/model selection.                             |
| `thinking`          | Effective reasoning level.                                      |
| `auth_source`       | `managed`, `runtime-key`, or `environment`; never a credential. |
| `session_id`        | Provider session identity.                                      |
| `session_file`      | Relative pointer to the raw JSONL under `agent/`.               |
| `prompt_version`    | Authoritative prompt version (`agent-v1`).                      |
| `prompt_hash`       | SHA-256 of the exact system prompt text.                        |
| `tool_catalog_hash` | SHA-256 of canonical tool names, schemas, and descriptions.     |

## Stable tool-call projection

`tool-calls.jsonl` is the reporting contract for agent tool activity. Each
line is a closed, schema-validated record with a run-local monotonic `seq`, a
`start` or `end` phase, sanitized input/output, terminal status, duration, and
optional stable error or confirmation linkage. The raw Pi session remains
available for provider-level inspection, but Yantra audit and report code do
not parse its private format.

The writer appends, flushes, and syncs one complete JSON line at a time. If a
process is terminated during a tool call, the file remains parseable and the
last call may have a `start` without an `end`; audit output labels that call
as incomplete instead of guessing an outcome.

## Agent usage

`usage.json` merges the existing per-call ledger with an `agent` total:
completed turns plus input tokens, output tokens, and cost when the provider
reports them. Missing local-model metrics are stored as `null`, never guessed
as zero. Failed and aborted runs still persist accumulated usage because
partial execution can incur real spend; `report.md` includes the same totals,
and `yantra usage` consumes agentic-run cost through the local history index.

## Auditing an agentic run

`yantra audit <run-id>` renders provider/model/prompt metadata, the relative
raw-session pointer, tool calls in sequence order, confirmation linkage, usage,
and the terminal outcome. A start record with no matching end is shown as
`⚠ incomplete`. Startup failures render their stable error code and safe
message. Structured rendering reads only `manifest.json`, `tool-calls.jsonl`,
`confirmations.jsonl`, `usage.json`, and Yantra event/secret projections; it
never opens or interprets `agent/*.jsonl`.
