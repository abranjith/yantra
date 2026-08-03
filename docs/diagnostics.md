# Diagnostics

## `yantra doctor`

Runs offline environment checks (Chrome, data directory, keychain, disk space)
and reports what the agent will do by default without opening a provider
session:

| Check id            | What it proves                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.model`       | Effective provider/model/thinking selection and whether each value came from a flag, environment variable, profile, or pinned default. |
| `agent.credentials` | Which credential source is present. No source is a `warn`, not an error: a deterministic-only installation is valid.                   |
| `agent.budgets`     | Effective duration, token, tool-timeout, retry, and confirmation values plus their source; user-entered duration units are preserved.  |

An environmental error exits `3`. Warnings alone do not fail the command.

## `yantra doctor --agent-smoke`

Runs a **live** agent provider smoke test. Select its target with the shared
agent flags, for example:

```bash
yantra doctor --agent-smoke --provider ollama --model llama3.1:8b
```

1. opens a real provider session against Yantra's pinned Pi environment
   (see [model-configuration.md](model-configuration.md));
2. registers a single `status` custom tool — no built-in tools, no ambient
   resources;
3. runs one prompt that invokes the tool and streams the normalized events;
4. persists the session under `runs/<run-id>/agent/` (see
   [run-artifacts.md](run-artifacts.md)) and closes cleanly.

The command prints the effective environment enumeration (pinned paths,
resource counts — all zeros) as evidence that nothing ambient was loaded.
Unlike the ordinary offline doctor report, a missing credential on this live
path is `AGENT_AUTH_UNAVAILABLE` (exit `3`).

Exit codes: `0` smoke passed; `3` typed startup failure or failed round-trip;
`130` aborted with Ctrl+C (clean teardown).

## Agent startup error codes

Agentic startup problems use stable typed codes. `do` and the live smoke path
surface them directly; `ask`, `research`, and `run` warn before taking their
documented deterministic fallback.

| Code                         | Meaning                                                                                                  | Fix                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_MODEL_NOT_FOUND`      | The provider/model pair is not in the model registry.                                                    | Check the model id (the error lists known ids). Local/custom models are defined in the pinned `models.json` — see [model-configuration.md](model-configuration.md). |
| `AGENT_AUTH_UNAVAILABLE`     | No credential resolved from the managed store, runtime key overrides, or provider environment variables. | Set the provider's API key env var (e.g. `ANTHROPIC_API_KEY`), seed the managed store, or configure a `runtime-key` secret reference.                               |
| `AGENT_PROVIDER_UNAVAILABLE` | The provider backend could not be reached or reported an error mid-run.                                  | Check network/status of the provider; retry.                                                                                                                        |
| `AGENT_SESSION_START_FAILED` | Session construction failed for another reason (e.g. an invalid thinking level).                         | The message names the offending input and expected values.                                                                                                          |
| `AGENT_ABORTED`              | The session was aborted (user interrupt or budget exhaustion).                                           | Informational — teardown was clean.                                                                                                                                 |

Error messages are sanitized: they name which credential _source_ was tried
and how to configure it, never key material.
