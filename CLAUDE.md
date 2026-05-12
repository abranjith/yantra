<!-- spec-lite managed — regenerated on spec-lite init/update -->

# Project Instructions

This project uses [spec-lite](https://github.com/abranjith/spec-lite) agent and skill prompts
for structured software engineering workflows.

## Available Agents & Skills

The following specialist agents and skills are available:

**Agent files** (`.claude/agents/`):

- [spec.architect](.claude/agents/spec.architect.md)
- [spec.brainstormer](.claude/agents/spec.brainstormer.md)
- [spec.explorer](.claude/agents/spec.explorer.md)
- [spec.planner](.claude/agents/spec.planner.md)
- [spec.feature_planner](.claude/agents/spec.feature_planner.md)
- [spec.yolo](.claude/agents/spec.yolo.md)
- [spec.data_model_builder](.claude/agents/spec.data_model_builder.md)
- [spec.devops](.claude/agents/spec.devops.md)
- [spec.feature](.claude/agents/spec.feature.md)
- [spec.fixer](.claude/agents/spec.fixer.md)
- [spec.implementer](.claude/agents/spec.implementer.md)
- [spec.memorize](.claude/agents/spec.memorize.md)
- [spec.plan_critic](.claude/agents/spec.plan_critic.md)
- [spec.code_reviewer](.claude/agents/spec.code_reviewer.md)
- [spec.performance_reviewer](.claude/agents/spec.performance_reviewer.md)
- [spec.security_reviewer](.claude/agents/spec.security_reviewer.md)
- [spec.todo](.claude/agents/spec.todo.md)
- [spec.tool_helper](.claude/agents/spec.tool_helper.md)
- [spec.integration_tester](.claude/agents/spec.integration_tester.md)
- [spec.readme_writer](.claude/agents/spec.readme_writer.md)
- [spec.unit_tester](.claude/agents/spec.unit_tester.md)
- [spec.orchestrator](.claude/agents/spec.orchestrator.md)

**Command files** (`.claude/commands/`):

- [spec.architect](.claude/commands/spec.architect.md)
- [spec.brainstorm](.claude/commands/spec.brainstorm.md)
- [spec.explore](.claude/commands/spec.explore.md)
- [spec.plan](.claude/commands/spec.plan.md)
- [spec.plan_feature](.claude/commands/spec.plan_feature.md)
- [spec.yolo](.claude/commands/spec.yolo.md)
- [spec.build_data_model](.claude/commands/spec.build_data_model.md)
- [spec.devops](.claude/commands/spec.devops.md)
- [spec.feature](.claude/commands/spec.feature.md)
- [spec.fix](.claude/commands/spec.fix.md)
- [spec.implement](.claude/commands/spec.implement.md)
- [spec.memorize](.claude/commands/spec.memorize.md)
- [spec.plan_critic](.claude/commands/spec.plan_critic.md)
- [spec.review_code](.claude/commands/spec.review_code.md)
- [spec.review_performance](.claude/commands/spec.review_performance.md)
- [spec.review_security](.claude/commands/spec.review_security.md)
- [spec.todo](.claude/commands/spec.todo.md)
- [spec.tool_help](.claude/commands/spec.tool_help.md)
- [spec.write_integration_tests](.claude/commands/spec.write_integration_tests.md)
- [spec.write_readme](.claude/commands/spec.write_readme.md)
- [spec.write_unit_tests](.claude/commands/spec.write_unit_tests.md)
- [spec.help](.claude/commands/spec.help.md)
- [spec.orchestrator](.claude/commands/spec.orchestrator.md)

## Usage

To use an agent, reference its prompt file in your conversation:

```text
Use the planner from .claude/agents/spec.planner.md to create a technical plan for this project.
```

## Output Directory

Agent and skill outputs are written to the `.spec-lite/` directory:

```text
.spec-lite/
├── brainstorm.md
├── plan.md                    # Default plan (simple projects)
├── plan_<name>.md              # Named plans (complex projects)
├── TODO.md
├── features/
└── reviews/
```
