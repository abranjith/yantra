# Agentic Release Gate

This checklist maps the agentic-runtime definition of done to the automated evidence that must be green for a release.

| Definition of done | Proof |
| --- | --- |
| Provider SDK is adapter-confined | `packages/agent/tests/boundaries/imports.spec.ts` and `pnpm security:static-check` |
| Provider session, tools, and run-local persistence work | adapter provider/smoke/tool suites and `e2e/agent-do.spec.ts` |
| `yantra do` has no manual loop | orchestrator tests and `packages/agent/tests/boundaries/forbidden.spec.ts` |
| Real Chrome supports navigation, actions, extraction, and workflow promotion/replay | `e2e/agent-browser.spec.ts` and `e2e/agent-workflow-bridge.spec.ts` |
| Sanitization, secrets, ethics, consent, budgets, and output validation are outside prompt text | middleware, browser-tool, chaos, and static-security suites |
| Pi has no ambient configuration or resources | `packages/agent/tests/adapters/pi/environment.spec.ts` |
| Confirmation waits fail closed | confirmation-bridge, orchestrator, and agent-do suites |
| Secret host binding, outbound URL controls, ephemeral profiles, and popup interception are enforced | browser security/controller suites and `e2e/agent-browser.spec.ts` |
| Startup errors are typed and auditable | provider, smoke, run-recorder, diagnostics, and audit-builder suites |
| Ask, research, and do share the agent runtime when reasoning is enabled | CLI command suites and `packages/agent/tests/runtime/profiles.spec.ts` |
| Deterministic ask/research/replay remain green | `pnpm test:no-llm` |
| Pre-agentic workflow YAML and run artifacts remain compatible | `e2e/cli-commands.spec.ts` compatibility scenario (load, replay, and audit) |
| Audit/report render session metadata and stable tool activity | run-recorder, audit-builder, and agent-do suites |
| Legacy scaffold is absent | `packages/agent/tests/boundaries/forbidden.spec.ts` |
| Documentation and generated protocol output are current | `pnpm --filter @yantra/protocol verify` |

## CI execution

The CI matrix runs build, tests, lint, and type checks on macOS, Windows, and Ubuntu with `LLM_PROVIDER=anthropic` and `LLM_PROVIDER=none`; Ubuntu additionally exercises the Ollama-enabled configuration. The release-gate job runs no-LLM tests, real-Chrome E2E coverage, protocol generation verification, static security checks, and legacy boundary assertions.

Live-provider and local-model smokes require credentials or a locally configured Ollama model. They are opt-in CI checks: enable them only with the appropriate secret/configuration, never by placing credentials in workflow YAML, source, examples, or artifacts.
