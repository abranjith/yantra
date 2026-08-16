# Project Instructions

Codex reads this file automatically for project-level context.

<!-- spec-lite:start -->

## spec-lite Agents & Skills

This project uses [spec-lite](https://github.com/abranjith/spec-lite) agent and skill prompts
for structured software engineering workflows.

Typical flow: brainstorm → plan → feature → implement → review → document. Memory supplies standing instructions across every role.

**Subagents** (`.codex/agents/`) — invoke by name (e.g., `use spec.planner`):

- [spec.architect](.codex/agents/spec.architect.toml)
- [spec.brainstormer](.codex/agents/spec.brainstormer.toml)
- [spec.planner](.codex/agents/spec.planner.toml)
- [spec.feature_planner](.codex/agents/spec.feature_planner.toml)
- [spec.yolo](.codex/agents/spec.yolo.toml)

**Skills** (`.agents/skills/`) — auto-discovered by Codex based on the task:

- [spec-build-data-model](.agents/skills/spec-build-data-model/SKILL.md)
- [spec-devops](.agents/skills/spec-devops/SKILL.md)
- [spec-document](.agents/skills/spec-document/SKILL.md)
- [spec-document-design](.agents/skills/spec-document-design/SKILL.md)
- [spec-document-feature](.agents/skills/spec-document-feature/SKILL.md)
- [spec-document-readme](.agents/skills/spec-document-readme/SKILL.md)
- [spec-document-usage](.agents/skills/spec-document-usage/SKILL.md)
- [spec-feature](.agents/skills/spec-feature/SKILL.md)
- [spec-fix](.agents/skills/spec-fix/SKILL.md)
- [spec-implement](.agents/skills/spec-implement/SKILL.md)
- [spec-memorize](.agents/skills/spec-memorize/SKILL.md)
- [spec-plan-critic](.agents/skills/spec-plan-critic/SKILL.md)
- [spec-review](.agents/skills/spec-review/SKILL.md)
- [spec-todo](.agents/skills/spec-todo/SKILL.md)
- [spec-tool-help](.agents/skills/spec-tool-help/SKILL.md)
- [spec-write-integration-tests](.agents/skills/spec-write-integration-tests/SKILL.md)
- [spec-write-unit-tests](.agents/skills/spec-write-unit-tests/SKILL.md)

Suggested manual checkpoint after planning:

- Use `spec.plan_critic` against `.spec-lite/plan.md` to pressure-test feasibility before implementation.

Planning outputs are written to `.spec-lite/`; documentation uses the directory configured in `.spec-lite.json`.

<!-- spec-lite:end -->
