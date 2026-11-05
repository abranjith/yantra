<!-- spec-lite managed — regenerated on spec-lite init/update -->

# Project Instructions

This project uses [spec-lite](https://github.com/abranjith/spec-lite) agent and skill prompts
for structured software engineering workflows.

## Available Agents & Skills

The following specialist agents and skills are available:

Typical flow: brainstorm → plan → feature → implement → review → document. Memory supplies standing instructions across every role.

**Agent files** (`.claude/agents/`):

- [spec-architect](.claude/agents/spec-architect.md)
- [spec-brainstormer](.claude/agents/spec-brainstormer.md)
- [spec-planner](.claude/agents/spec-planner.md)
- [spec-feature-planner](.claude/agents/spec-feature-planner.md)
- [spec-yolo](.claude/agents/spec-yolo.md)
- [spec-data-model-builder](.claude/agents/spec-data-model-builder.md)
- [spec-devops](.claude/agents/spec-devops.md)
- [spec-documenter](.claude/agents/spec-documenter.md)
- [spec-design-documenter](.claude/agents/spec-design-documenter.md)
- [spec-feature-documenter](.claude/agents/spec-feature-documenter.md)
- [spec-readme-writer](.claude/agents/spec-readme-writer.md)
- [spec-usage-documenter](.claude/agents/spec-usage-documenter.md)
- [spec-feature](.claude/agents/spec-feature.md)
- [spec-fixer](.claude/agents/spec-fixer.md)
- [spec-hook-helper](.claude/agents/spec-hook-helper.md)
- [spec-implementer](.claude/agents/spec-implementer.md)
- [spec-memorize](.claude/agents/spec-memorize.md)
- [spec-plan-critic](.claude/agents/spec-plan-critic.md)
- [spec-reviewer](.claude/agents/spec-reviewer.md)
- [spec-todo](.claude/agents/spec-todo.md)
- [spec-tool-helper](.claude/agents/spec-tool-helper.md)
- [spec-integration-tester](.claude/agents/spec-integration-tester.md)
- [spec-unit-tester](.claude/agents/spec-unit-tester.md)

**Skill directories** (`.claude/skills/`) — auto-discovered, or run with `/<name>`:

- [spec-build-data-model](.claude/skills/spec-build-data-model/SKILL.md)
- [spec-devops](.claude/skills/spec-devops/SKILL.md)
- [spec-document](.claude/skills/spec-document/SKILL.md)
- [spec-document-design](.claude/skills/spec-document-design/SKILL.md)
- [spec-document-feature](.claude/skills/spec-document-feature/SKILL.md)
- [spec-document-readme](.claude/skills/spec-document-readme/SKILL.md)
- [spec-document-usage](.claude/skills/spec-document-usage/SKILL.md)
- [spec-feature](.claude/skills/spec-feature/SKILL.md)
- [spec-fix](.claude/skills/spec-fix/SKILL.md)
- [spec-hook-help](.claude/skills/spec-hook-help/SKILL.md)
- [spec-implement](.claude/skills/spec-implement/SKILL.md)
- [spec-memorize](.claude/skills/spec-memorize/SKILL.md)
- [spec-plan-critic](.claude/skills/spec-plan-critic/SKILL.md)
- [spec-review](.claude/skills/spec-review/SKILL.md)
- [spec-todo](.claude/skills/spec-todo/SKILL.md)
- [spec-tool-help](.claude/skills/spec-tool-help/SKILL.md)
- [spec-write-integration-tests](.claude/skills/spec-write-integration-tests/SKILL.md)
- [spec-write-unit-tests](.claude/skills/spec-write-unit-tests/SKILL.md)

**Command files** (`.claude/commands/`):

- [spec-architect](.claude/commands/spec-architect.md)
- [spec-brainstorm](.claude/commands/spec-brainstorm.md)
- [spec-plan](.claude/commands/spec-plan.md)
- [spec-plan-feature](.claude/commands/spec-plan-feature.md)
- [spec-yolo](.claude/commands/spec-yolo.md)
- [spec-help](.claude/commands/spec-help.md)
- [spec-orchestrator](.claude/commands/spec-orchestrator.md)

## Usage

To use an agent, ask Claude to delegate to it by name:

```text
Use the spec-planner agent to create a technical plan for this project.
```

Suggested manual checkpoint after planning:

```text
/spec-plan-critic .spec-lite/plan.md
```

## Output Directory

Planning, feature, review, and memory outputs are written to `.spec-lite/`; project documentation uses the directory configured in `.spec-lite.json`:

```text
.spec-lite/
├── brainstorm.md
├── plan.md                    # Default plan (simple projects)
├── plan_<name>.md              # Named plans (complex projects)
├── TODO.md
├── memory.md
├── features/
└── reviews/
```
