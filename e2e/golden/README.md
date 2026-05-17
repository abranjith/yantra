# Golden Plan Fixtures

Canonical intent → validated Plan snapshots, pinned per LLM model and provider.

## Format

Each fixture is a `.golden.json` file with the shape:

```json
{
  "intent": "the sanitized user intent string",
  "provider_id": "anthropic:claude-sonnet-4-6",
  "model": "claude-sonnet-4-6",
  "schema_version": "0.1",
  "plan": { ... }
}
```

Filename convention: `<slug>.<provider_id>.golden.json`  
Example: `navigate-to-url.anthropic_claude-sonnet-4-6.golden.json`

## Regenerating Fixtures

Run when:

- A new major LLM model is deployed (bump the model ID in config.yaml).
- `packages/protocol` step schema changes.
- The system prompt is substantially revised.

```sh
pnpm --filter @yantra/agent golden:rerecord
```

This requires `LLM_PROVIDER=anthropic` (or `=ollama`) and valid credentials.
The script diffs the new plan against the current fixture and waits for manual
approval before overwriting. Approve each fixture individually.

## CI Behavior

The suite runs automatically on every:

- Dependency bump of `pi-agent-core`
- Model ID change in `~/.config/yantra/config.yaml`

A Turborepo `inputs` declaration triggers re-run on relevant config changes.

If a fixture file is present and the emitted plan differs, CI fails with a
side-by-side diff. Intentional changes must be re-recorded and committed.

## Adding Canonical Intents

During MVP dogfooding, populate this directory with 3–5 representative intents
covering the main automation use cases. One `.golden.json` per intent per
supported provider.

This directory ships with a `.gitkeep` — fixtures are added during dogfooding.
