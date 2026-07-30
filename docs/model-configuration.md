# Model Configuration & Agent Credentials

Yantra's agentic commands run on a provider session backed by the
`@earendil-works/pi-coding-agent` SDK. This page explains where Yantra keeps
the agent runtime's credentials and model definitions, and how credential
resolution is audited.

## Selecting provider and model

`yantra ask`, `yantra research`, and `yantra do` each open exactly one provider
session, so all three accept the same selection flags. `yantra run --llm` accepts
the identical surface for writing a replayed workflow's Brief (see
[Model selection in replay](#model-selection-in-replay) below):

| Flag                  | Meaning                                                          | Environment fallback    |
| --------------------- | ---------------------------------------------------------------- | ----------------------- |
| `--provider <name>`   | Provider key, e.g. `anthropic` or `ollama`.                      | `YANTRA_AGENT_PROVIDER` |
| `--model <id>`        | Provider-scoped model identifier.                                | `YANTRA_AGENT_MODEL`    |
| `--thinking <level>`  | Reasoning level; adapters clamp it to the model's capability.    | —                       |
| `--auth-secret <ref>` | Secret reference selecting `runtime-key` auth (see table below). | —                       |

Resolution order is **explicit flag > environment > pinned default**
(`anthropic` / `claude-haiku-4-5`). A blank provider, model, or secret
reference is a typed validation failure (exit 1) — the CLI never quietly
substitutes a different model or downgrades the credential mode. Deterministic
`--no-llm` runs ignore these flags because they never build a session.

## Model selection in replay

`yantra run` replays a saved workflow. It is deterministic and model-free by
default, and stays that way even if model flags or `YANTRA_AGENT_*` variables are
present — a replay never opens a provider session unless you ask for one:

```bash
yantra run quarterly-report                 # deterministic Brief, no session
yantra run quarterly-report --llm           # model-written Brief, pinned default
yantra run quarterly-report --llm --provider ollama --model llama3.1:8b
yantra run quarterly-report --no-llm        # explicit deterministic
```

`--llm` affects **only** how the run's Brief is worded, and only for a workflow
that declares a `synthesis:` block. It never influences which steps run: step
selection, branch conditions, loop bounds, and locator resolution are fixed and
validated before execution. See
[agentic-runtime.md](agentic-runtime.md#llm-in-replay) for the full invariant.

Two surfaces ignore `--llm` entirely and are always zero-LLM:

- **Scheduled / daemon runs** — an unattended fire never opens a session.
- **Nested `workflow_run` calls** — a workflow invoked by an agent replays
  deterministically inside the agent's own run.

Because the model only writes prose, a synthesis failure is never fatal: an
unreachable provider, an unusable credential, or output that never validates
falls back to the deterministic Brief, and the run still succeeds with its
outputs intact.

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

Absence of any usable credential is a **typed startup failure**
(`AGENT_AUTH_UNAVAILABLE`) with a fix hint — agentic commands never silently
fall back to a non-LLM implementation. To intentionally use no credentials,
select the deterministic `ask` or `research` pipeline with `--no-llm` or
`LLM_PROVIDER=none`; that selection occurs before any agent session is built.

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
