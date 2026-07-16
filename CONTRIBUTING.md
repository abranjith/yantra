# Contributing

## Monorepo Workflow

- Use pnpm only.
- Install dependencies from repository root.
- Do not run `npm install` inside workspace packages.
- Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` before opening a PR.

## Architectural Boundaries

ESLint and boundary suites enforce the hard boundaries in [eslint.config.js](eslint.config.js):

- `packages/core` must not import `@yantra/agent`.
- `@earendil-works/pi-coding-agent` imports are allowed only in `packages/agent/src/adapters/pi/`.
- The deleted task-shaped client scaffold cannot be reintroduced. Its paths and symbols are checked by `packages/agent/tests/boundaries/forbidden.spec.ts` on every test run.

Boundary fixtures live under `src/_lint-fixtures` and the checks run in the core and agent boundary suites. To intentionally amend the forbidden list, update the governing plan and `.spec-lite/memory.md` first, then make the matching change in `packages/agent/tests/boundaries/forbidden.ts` with its verification coverage.

## TypeScript Baseline

- Extend [tsconfig.base.json](tsconfig.base.json) for all new packages.
- Keep strict mode enabled.
- Use ESM-only output.

## Test Tags

- Use `@no-llm` in describe titles for tests that must pass in all provider modes.
- Use `itRequiresLlm` from `@yantra/test-helpers` only for LLM-required tests.
- Keep critical spine tests `@no-llm`.

## Formatting And Pre-Commit

- Prettier config lives in [.prettierrc](.prettierrc).
- Lefthook runs `lint-staged` on pre-commit via [lefthook.yml](lefthook.yml).
- Emergency bypass is possible with `git commit --no-verify`, but avoid it unless necessary.

## Adding A New Package

1. Create `package.json`, `tsconfig.json`, `tsconfig.build.json`, and `vitest.config.ts`.
2. Add source and smoke test under `src/`.
3. Add workspace reference in [tsconfig.json](tsconfig.json).
4. Ensure package path matches [pnpm-workspace.yaml](pnpm-workspace.yaml).
5. Add or update README entries if user-facing.

## Commits

Conventional Commits are recommended but not enforced for MVP.
