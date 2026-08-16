<!-- spec-lite managed — regenerated on spec-lite init/update -->

# Project Instructions

This project uses [spec-lite](https://github.com/abranjith/spec-lite) agent and skill prompts
for structured software engineering workflows.

## Available Agents & Skills

The following specialist agents and skills are available:

Typical flow: brainstorm → plan → feature → implement → review → document. Memory supplies standing instructions across every role.

**Agent files** (`.claude/agents/`):

- [spec.architect](.claude/agents/spec.architect.md)
- [spec.brainstormer](.claude/agents/spec.brainstormer.md)
- [spec.planner](.claude/agents/spec.planner.md)
- [spec.feature_planner](.claude/agents/spec.feature_planner.md)
- [spec.yolo](.claude/agents/spec.yolo.md)
- [spec.data_model_builder](.claude/agents/spec.data_model_builder.md)
- [spec.devops](.claude/agents/spec.devops.md)
- [spec.documenter](.claude/agents/spec.documenter.md)
- [spec.design_documenter](.claude/agents/spec.design_documenter.md)
- [spec.feature_documenter](.claude/agents/spec.feature_documenter.md)
- [spec.readme_writer](.claude/agents/spec.readme_writer.md)
- [spec.usage_documenter](.claude/agents/spec.usage_documenter.md)
- [spec.feature](.claude/agents/spec.feature.md)
- [spec.fixer](.claude/agents/spec.fixer.md)
- [spec.implementer](.claude/agents/spec.implementer.md)
- [spec.memorize](.claude/agents/spec.memorize.md)
- [spec.plan_critic](.claude/agents/spec.plan_critic.md)
- [spec.reviewer](.claude/agents/spec.reviewer.md)
- [spec.todo](.claude/agents/spec.todo.md)
- [spec.tool_helper](.claude/agents/spec.tool_helper.md)
- [spec.integration_tester](.claude/agents/spec.integration_tester.md)
- [spec.unit_tester](.claude/agents/spec.unit_tester.md)

**Command files** (`.claude/commands/`):

- [spec.architect](.claude/commands/spec.architect.md)
- [spec.brainstorm](.claude/commands/spec.brainstorm.md)
- [spec.plan](.claude/commands/spec.plan.md)
- [spec.plan_feature](.claude/commands/spec.plan_feature.md)
- [spec.yolo](.claude/commands/spec.yolo.md)
- [spec.build_data_model](.claude/commands/spec.build_data_model.md)
- [spec.devops](.claude/commands/spec.devops.md)
- [spec.document](.claude/commands/spec.document.md)
- [spec.document_design](.claude/commands/spec.document_design.md)
- [spec.document_feature](.claude/commands/spec.document_feature.md)
- [spec.document_readme](.claude/commands/spec.document_readme.md)
- [spec.document_usage](.claude/commands/spec.document_usage.md)
- [spec.feature](.claude/commands/spec.feature.md)
- [spec.fix](.claude/commands/spec.fix.md)
- [spec.implement](.claude/commands/spec.implement.md)
- [spec.memorize](.claude/commands/spec.memorize.md)
- [spec.plan_critic](.claude/commands/spec.plan_critic.md)
- [spec.review](.claude/commands/spec.review.md)
- [spec.todo](.claude/commands/spec.todo.md)
- [spec.tool_help](.claude/commands/spec.tool_help.md)
- [spec.write_integration_tests](.claude/commands/spec.write_integration_tests.md)
- [spec.write_unit_tests](.claude/commands/spec.write_unit_tests.md)
- [spec.help](.claude/commands/spec.help.md)
- [spec.orchestrator](.claude/commands/spec.orchestrator.md)

## Usage

To use an agent, reference its prompt file in your conversation:

```text
Use the planner from .claude/agents/spec.planner.md to create a technical plan for this project.
```

Suggested manual checkpoint after planning:

```text
Use the plan critic from .claude/agents/spec.plan_critic.md to review .spec-lite/plan.md for feasibility, technical risks, product improvements, and future enhancements before implementation starts.
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
