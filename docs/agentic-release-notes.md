# Agentic Runtime Release Notes

Yantra now has one governed agent runtime behind `yantra do` and the LLM-enabled forms of `yantra ask` and `yantra research`. Each task opens a fresh provider session, exposes only policy-wrapped Yantra tools, enforces command-specific budgets and confirmations outside the prompt, and accepts success only after a schema-valid Brief is published.

## What users get

- Live web research and real-Chrome interaction through bounded search, fetch, browser, script, workflow, and result-publication tools.
- Deterministic `--no-llm` ask/research and saved-workflow replay remain available without model credentials.
- Auditable run directories containing the manifest, stable tool activity, usage, confirmations, trace, published Brief, and a run-local provider session reference.
- Typed startup diagnostics for unavailable credentials, providers, models, and sessions.
- Workflow promotion with `yantra do --save-as <name>`, followed by repeatable LLM-free replay with `yantra run <name>`.

## Configuration and compatibility

Anthropic remains the default provider. Managed credentials, runtime-key injection, environment-based credentials, and explicitly configured Ollama custom models are supported; see [Model Configuration](model-configuration.md). Credentials must not be placed in workflow YAML, command history, examples, or run artifacts.

The internal `@yantra/agent` task-shaped client, null-provider fallback, manual discovery loop, and generated step-tool catalog were removed. This is a clean break for internal package consumers only: existing version-1 workflow YAML and pre-agentic run directories continue to load, replay, and audit.

### Report-template guidance compatibility

Report templates now reserve whole-line `<!-- guidance: ... -->` comments for
model-only author instructions. An existing template that used that exact form
as an ordinary comment, such as `<!-- guidance: see the wiki -->`, now parses as
a directive and fails if no later model-filled slot consumes it. Because
`yantra template list` omits invalid saved templates, an affected template can
disappear from the listing without an inline explanation; run
`yantra template lint <name-or-path>` to see and correct the positional error.

## Safety defaults

The provider SDK is confined to its adapter. Model code has no unrestricted filesystem or shell tool and cannot bypass URL policy, sanitization, secret host binding, ethics checks, budgets, or confirmation. Non-interactive confirmation requests fail closed, while CAPTCHA and other human-only situations produce a typed handoff.

See [Agent Tools and Safety](agent-tools.md), [Run Artifacts](run-artifacts.md), [Diagnostics](diagnostics.md), and the [Release Gate](release-gate.md) for operational details and verification evidence.
