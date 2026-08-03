# Model Configuration & Agent Credentials

Yantra's agentic commands run on a provider session backed by the
`@earendil-works/pi-coding-agent` SDK. This page explains where Yantra keeps
the agent runtime's credentials and model definitions, and how credential
resolution is audited.

## Agentic options

`ask`, `research`, `do`, `run`, and `resume` register one shared agentic option
surface. This table is the canonical reference for its defaults:

| Flag                           | Meaning                                                   | `profile.yaml` key      | Environment                    | Default            |
| ------------------------------ | --------------------------------------------------------- | ----------------------- | ------------------------------ | ------------------ |
| `--provider <name>`            | Provider key, such as `anthropic` or `ollama`.            | `agent.provider`        | `YANTRA_AGENT_PROVIDER`        | `anthropic`        |
| `--model <id>`                 | Provider-scoped model identifier.                         | `agent.model`           | `YANTRA_AGENT_MODEL`           | `claude-haiku-4-5` |
| `--thinking <level>`           | Reasoning level; adapters clamp it to model capability.   | `agent.thinking`        | `YANTRA_AGENT_THINKING`        | unset              |
| `--auth-secret <ref>`          | OS-keychain reference selecting runtime-only auth.        | —                       | `YANTRA_AGENT_AUTH_SECRET`     | managed auth       |
| `--max-duration <duration>`    | Hard wall clock for the whole agent run.                  | `agent.max_duration`    | `YANTRA_AGENT_MAX_DURATION`    | `15m`              |
| `--max-tokens <n>`             | Cumulative provider-token ceiling.                        | `agent.max_tokens`      | `YANTRA_AGENT_MAX_TOKENS`      | `2000000`          |
| `--tool-timeout <duration>`    | Timeout for one tool call.                                | `agent.tool_timeout`    | `YANTRA_AGENT_TOOL_TIMEOUT`    | `3m`               |
| `--tool-retries <n>`           | Retries allowed after an identical tool/error pair fails. | `agent.tool_retries`    | `YANTRA_AGENT_TOOL_RETRIES`    | `3`                |
| `--confirm-timeout <duration>` | Maximum live consent wait.                                | `agent.confirm_timeout` | `YANTRA_AGENT_CONFIRM_TIMEOUT` | `3m`               |
| `--no-llm`                     | Force the deterministic path where the command has one.   | —                       | `LLM_PROVIDER=none`            | model enabled      |

Resolution is **explicit flag > environment > profile preference > pinned
default**. Layers that do not apply are marked “—” above. An explicit
`--no-llm` or `LLM_PROVIDER=none` is resolved first, so unused model and budget
values are not validated. Otherwise blank provider, model, or auth references
and invalid budgets are typed validation failures (exit 1).

Durations are positive integers with an optional `ms`, `s`, `m`, or `h` suffix;
a bare integer means milliseconds. Examples: `900000`, `900s`, and `15m`.
Fractions, negative values, zero, and unknown units are rejected.

The 15-minute run has an 80% exploration wind-down point at 12 minutes. After
that soft boundary, non-terminal tool calls are refused with guidance to publish
the evidence already gathered; `result_publish` remains available until the hard
deadline. A Brief produced during wind-down may therefore be labeled partial.

## Model selection in replay

`yantra run` replays a saved workflow. **The workflow decides whether a model
writes its Brief** — via `synthesis.use_llm`, recorded when the workflow was
saved — so there is no mode flag to remember and `yantra run <name>` behaves the
same way every time it is typed. Model flags and `YANTRA_AGENT_*` variables
select _which_ model that workflow gets; they never opt a workflow in:

```bash
yantra run quarterly-report                             # whatever the workflow declares
yantra run quarterly-report --provider ollama --model llama3.1:8b
yantra run quarterly-report --no-llm                    # force deterministic
yantra resume <run-id> --model claude-sonnet-5
```

A workflow whose `synthesis.use_llm` is false — the default, and the state of
every workflow saved before the field existed — opens no provider session no
matter which model flags are present.

`resume` accepts the same selection surface when it inherits an LLM synthesis
strategy. Agent budget flags govern live agent work; they do not alter a
deterministic replay.

The model affects **only** how the run's Brief is worded, and only for a workflow
that declares a `synthesis:` block. It never influences which steps run: step
selection, branch conditions, loop bounds, and locator resolution are fixed and
validated before execution. See
[agentic-runtime.md](agentic-runtime.md#llm-in-replay) for the full invariant.

Three things force the deterministic path regardless of what a workflow declares:

- **`--no-llm`** — the same flag `ask` and `research` use; `LLM_PROVIDER=none`
  works the same way.
- **Scheduled / daemon runs** — an unattended fire never opens a session.
- **Nested `workflow_run` calls** — a workflow invoked by an agent replays
  deterministically inside the agent's own run.

Because the model only writes prose, a synthesis failure is never fatal: an
unreachable provider, an unusable credential, an adapter that cannot even be
constructed, or output that never validates falls back to the deterministic
Brief, and the run still succeeds with its outputs intact. The degradation is
logged as a warning and recorded in `manifest.synthesis` as
`{"strategy": "deterministic", "fallbackUsed": true}`, which is also what lets
`yantra resume` re-offer the model rather than inheriting the downgrade.

## Pinned, Yantra-owned Pi paths

Yantra never uses your interactive `~/.pi` installation or any project-local
`.pi/` settings. The agent runtime is constructed against **pinned paths
under the Yantra data directory**:

```text
<yantra-data-dir>/pi/            # e.g. ~/.local/share/yantra/pi (Linux/macOS)
  auth.json                      #      %LOCALAPPDATA%\yantra\pi (Windows)
  models.json
  sessions/                      # staging only; sessions live under their run
```

Settings are supplied **in-memory** with pinned overrides — no `settings.json`
is ever read from disk, and no ambient extensions, skills, prompt templates,
themes, or context files (`AGENTS.md`, `CLAUDE.md`) are loaded. A startup
enumeration test enforces this isolation.

## Credential sources

Model credentials resolve through one of these paths (recorded per run as
`auth_source` in the run manifest so the credential origin is auditable):

| `auth_source`   | Meaning                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managed`       | Credential stored in Yantra's pinned `auth.json`.                                                                                                                       |
| `runtime-key`   | A Yantra secret reference (OS keychain) resolved at session start into a runtime-only key. Never persisted, never logged, never placed in prompts or session artifacts. |
| `environment`   | A provider environment variable (e.g. `ANTHROPIC_API_KEY`). Supported as-is; note the audit trail records that the key came from the environment.                       |
| `models-config` | Request auth configured in `models.json` (custom providers).                                                                                                            |

Credential availability is probed offline before a session opens. When none of
the sources above resolves, commands with a useful deterministic path (`ask`,
`research`, and replay synthesis in `run`) print one warning naming the selected
provider/model and continue deterministically. `do` and `doctor --agent-smoke`
have no meaningful deterministic result, so they fail with the typed
`AGENT_AUTH_UNAVAILABLE` startup error (exit 3) and an actionable fix hint.

## Opting in to a personal pi credential store

If you already use the `pi` CLI interactively and want Yantra's `managed` auth
to reuse those credentials, set the explicit opt-in in
`~/.config/yantra/config.yaml`:

```yaml
agent:
  # Absolute path to an existing personal pi auth.json (explicit opt-in;
  # never a default). Only the auth path changes — settings, models, and
  # session placement stay pinned and Yantra-owned.
  pi_auth_path: /home/you/.pi/agent/auth.json
```

## Local models (Ollama and other custom providers)

Custom and local models are defined in the pinned
`<yantra-data-dir>/pi/models.json` using Pi's supported custom-model format.
Yantra does not maintain a bespoke direct-fetch client; local models flow
through the same session runtime and the same audit trail.

For a local Ollama server, create that file with the following non-secret
configuration, then select the matching provider/model with the shared model
flags above — on `ask` and `research` as well as `do`:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "llama3.1:8b", "contextWindow": 16384 }]
    }
  }
}
```

The `apiKey` value is an Ollama placeholder, not a credential. Do not put a
remote provider key in this file; use managed, runtime-key, or environment
credentials instead. If a local server does not support Pi's developer role or
reasoning controls, use the relevant Pi `compat` options in this same file.

### Declare the real context window (required for reliable agentic runs)

A `models.json` model that omits `contextWindow` is assumed by the session
runtime to have a **128,000-token** window, so context compaction never
engages for small local models. Ollama, meanwhile, serves models with its own
context limit (`num_ctx`, default **4096**) and **silently truncates the
prompt from the front** when a conversation exceeds it — the system prompt,
your goal, and the tool definitions are dropped first. The visible symptom is
an agent that answers off-topic, "forgets" the task after a large tool result
(a fetched page easily exceeds 4096 tokens on its own), stops calling tools,
and ends with `AGENT_COMPLETION_MISSING`. Yantra logs a startup warning when
it detects an undeclared `contextWindow` on a custom model.

To run agentic `ask`/`research`/`do` against a local model:

1. **Raise the server's context limit.** For Ollama, set the
   `OLLAMA_CONTEXT_LENGTH` environment variable on the server (for example
   `16384`), or bake `PARAMETER num_ctx 16384` into a Modelfile. Restart the
   server after changing it.
2. **Declare the same value in `models.json`** as `contextWindow` (see the
   example above) so compaction engages before the server's limit is hit.
3. **Point the command at it**, e.g.
   `yantra ask "..." --provider ollama --model llama3.1:8b` (or export
   `YANTRA_AGENT_PROVIDER` / `YANTRA_AGENT_MODEL` to make it the default).

Models served with a 4k window are generally too small for web tasks: a
single fetched page plus the prompt can exceed the whole window, which no
amount of compaction can fix. Prefer 16k or more.
