# Yantra

AI-orchestrated browser automation platform with a TypeScript monorepo foundation.

## Prerequisites

- Node v24.15.0 LTS
- pnpm (workspace uses packageManager from [package.json](package.json))
- System Chrome (used by later features)

## Quickstart

```bash
pnpm install
pnpm test
```

## Commands

| Command            | Description                        |
| ------------------ | ---------------------------------- |
| `pnpm build`       | Build all workspaces via Turborepo |
| `pnpm test`        | Run all workspace test suites      |
| `pnpm test:no-llm` | Run tests with `LLM_PROVIDER=none` |
| `pnpm lint`        | Lint the full repository           |
| `pnpm typecheck`   | Type-check all workspaces          |
| `pnpm format`      | Format repository files            |
| `pnpm clean`       | Clean build outputs                |

## Packages

- `@yantra/protocol`: Zod schemas as the single source of truth for the agent/engine contract; TypeScript types, JSON Schema, and tool definitions are generated from these schemas.
- `@yantra/core`: Core runtime and execution engine surface.
- `@yantra/agent`: Agent-side integration surface.
- `@yantra/test-helpers`: Internal helpers for test-provider tags.
- `@yantra/cli`: CLI entrypoint package.
- `e2e/`: Cross-package integration and smoke tests.

## Documentation

- Canonical project documentation lives under `docs/`.
- Protocol specification is generated at `docs/protocol-spec.md`.

## Continuous Integration

CI runs a 7-cell matrix:

- `LLM_PROVIDER=anthropic` on Ubuntu, macOS, and Windows
- `LLM_PROVIDER=none` on Ubuntu, macOS, and Windows
- `LLM_PROVIDER=ollama` on Ubuntu only

See [.github/workflows/ci.yml](.github/workflows/ci.yml) for details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
