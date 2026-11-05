<!-- spec-lite:start -->

## spec-lite Agents & Skills

This project uses [spec-lite](https://github.com/abranjith/spec-lite) agent and skill prompts
for structured software engineering workflows.

The following specialist agents and skills are available:

Typical flow: brainstorm → plan → feature → implement → review → document. Memory supplies standing instructions across every role.

**Agent files** (`.github/agents/`) — select from the agents dropdown in Copilot Chat:

- [spec-architect](.github/agents/spec-architect.agent.md)
- [spec-brainstormer](.github/agents/spec-brainstormer.agent.md)
- [spec-planner](.github/agents/spec-planner.agent.md)
- [spec-feature-planner](.github/agents/spec-feature-planner.agent.md)
- [spec-yolo](.github/agents/spec-yolo.agent.md)
- [spec-data-model-builder](.github/agents/spec-data-model-builder.agent.md)
- [spec-devops](.github/agents/spec-devops.agent.md)
- [spec-documenter](.github/agents/spec-documenter.agent.md)
- [spec-design-documenter](.github/agents/spec-design-documenter.agent.md)
- [spec-feature-documenter](.github/agents/spec-feature-documenter.agent.md)
- [spec-readme-writer](.github/agents/spec-readme-writer.agent.md)
- [spec-usage-documenter](.github/agents/spec-usage-documenter.agent.md)
- [spec-feature](.github/agents/spec-feature.agent.md)
- [spec-fixer](.github/agents/spec-fixer.agent.md)
- [spec-hook-helper](.github/agents/spec-hook-helper.agent.md)
- [spec-implementer](.github/agents/spec-implementer.agent.md)
- [spec-memorize](.github/agents/spec-memorize.agent.md)
- [spec-plan-critic](.github/agents/spec-plan-critic.agent.md)
- [spec-reviewer](.github/agents/spec-reviewer.agent.md)
- [spec-todo](.github/agents/spec-todo.agent.md)
- [spec-tool-helper](.github/agents/spec-tool-helper.agent.md)
- [spec-integration-tester](.github/agents/spec-integration-tester.agent.md)
- [spec-unit-tester](.github/agents/spec-unit-tester.agent.md)
- [spec-help](.github/agents/spec-help.agent.md)
- [spec-orchestrator](.github/agents/spec-orchestrator.agent.md)

**Skill directories** (`.github/skills/`) — auto-discovered by Copilot based on task:

- [spec-build-data-model](.github/skills/spec-build-data-model/SKILL.md)
- [spec-devops](.github/skills/spec-devops/SKILL.md)
- [spec-document](.github/skills/spec-document/SKILL.md)
- [spec-document-design](.github/skills/spec-document-design/SKILL.md)
- [spec-document-feature](.github/skills/spec-document-feature/SKILL.md)
- [spec-document-readme](.github/skills/spec-document-readme/SKILL.md)
- [spec-document-usage](.github/skills/spec-document-usage/SKILL.md)
- [spec-feature](.github/skills/spec-feature/SKILL.md)
- [spec-fix](.github/skills/spec-fix/SKILL.md)
- [spec-hook-help](.github/skills/spec-hook-help/SKILL.md)
- [spec-implement](.github/skills/spec-implement/SKILL.md)
- [spec-memorize](.github/skills/spec-memorize/SKILL.md)
- [spec-plan-critic](.github/skills/spec-plan-critic/SKILL.md)
- [spec-review](.github/skills/spec-review/SKILL.md)
- [spec-todo](.github/skills/spec-todo/SKILL.md)
- [spec-tool-help](.github/skills/spec-tool-help/SKILL.md)
- [spec-write-integration-tests](.github/skills/spec-write-integration-tests/SKILL.md)
- [spec-write-unit-tests](.github/skills/spec-write-unit-tests/SKILL.md)

**Prompt files** (`.github/prompts/`) — reference with `#file` or browse with `/`:

- [spec-architect](.github/prompts/spec-architect.prompt.md)
- [spec-brainstorm](.github/prompts/spec-brainstorm.prompt.md)
- [spec-plan](.github/prompts/spec-plan.prompt.md)
- [spec-plan-feature](.github/prompts/spec-plan-feature.prompt.md)
- [spec-yolo](.github/prompts/spec-yolo.prompt.md)
- [spec-help](.github/prompts/spec-help.prompt.md)
- [spec-orchestrator](.github/prompts/spec-orchestrator.prompt.md)

Suggested manual checkpoint after planning:

- `/spec-plan-critic .spec-lite/plan.md`
- `/spec-plan-critic .spec-lite/plan_<name>.md .spec-lite/brainstorm.md`
- `/spec-plan-critic .spec-lite/plan_<name>.md .spec-lite/features/feature_<name>.md`

To invoke an agent, select it from the agents dropdown, reference a prompt file with `#file`,
or describe the task and Copilot will auto-discover the right skill.

<!-- spec-lite:end -->
