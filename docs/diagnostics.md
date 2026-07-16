# Diagnostics

## `yantra doctor`

Runs offline environment checks (Chrome, data directory, keychain, disk
space). Exit code `3` signals an environment failure.

## `yantra doctor --agent-smoke [provider/model]`

Runs a **live** agent provider smoke test (default target:
`anthropic/claude-haiku-4-5`):

1. opens a real provider session against Yantra's pinned Pi environment
   (see [model-configuration.md](model-configuration.md));
2. registers a single `status` custom tool — no built-in tools, no ambient
   resources;
3. runs one prompt that invokes the tool and streams the normalized events;
4. persists the session under `runs/<run-id>/agent/` (see
   [run-artifacts.md](run-artifacts.md)) and closes cleanly.

The command prints the effective environment enumeration (pinned paths,
resource counts — all zeros) as evidence that nothing ambient was loaded.

Exit codes: `0` smoke passed; `3` typed startup failure or failed round-trip;
`130` aborted with Ctrl+C (clean teardown).

## Agent startup error codes

Agentic startup problems are **typed failures** — never a silent fallback to
a non-LLM implementation.

| Code                         | Meaning                                                                                                  | Fix                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_MODEL_NOT_FOUND`      | The provider/model pair is not in the model registry.                                                    | Check the model id (the error lists known ids). Local/custom models are defined in the pinned `models.json` — see [model-configuration.md](model-configuration.md). |
| `AGENT_AUTH_UNAVAILABLE`     | No credential resolved from the managed store, runtime key overrides, or provider environment variables. | Set the provider's API key env var (e.g. `ANTHROPIC_API_KEY`), seed the managed store, or configure a `runtime-key` secret reference.                               |
| `AGENT_PROVIDER_UNAVAILABLE` | The provider backend could not be reached or reported an error mid-run.                                  | Check network/status of the provider; retry.                                                                                                                        |
| `AGENT_SESSION_START_FAILED` | Session construction failed for another reason (e.g. an invalid thinking level).                         | The message names the offending input and expected values.                                                                                                          |
| `AGENT_ABORTED`              | The session was aborted (user interrupt or budget exhaustion).                                           | Informational — teardown was clean.                                                                                                                                 |

Error messages are sanitized: they name which credential _source_ was tried
and how to configure it, never key material.
