# Model Configuration & Agent Credentials

Yantra's agentic commands run on a provider session backed by the
`@earendil-works/pi-coding-agent` SDK. This page explains where Yantra keeps
the agent runtime's credentials and model definitions, and how credential
resolution is audited.

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
configuration, then select the matching provider/model with your normal
`yantra do` model flags:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "llama3.1:8b" }]
    }
  }
}
```

The `apiKey` value is an Ollama placeholder, not a credential. Do not put a
remote provider key in this file; use managed, runtime-key, or environment
credentials instead. If a local server does not support Pi's developer role or
reasoning controls, use the relevant Pi `compat` options in this same file.
