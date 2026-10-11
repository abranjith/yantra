import { describe, expect, it } from 'vitest';

import { GOAL_ECHO_MAX_CHARS, renderGoalEcho } from '../../src/render/goal-echo.js';

describe('@no-llm renderGoalEcho', () => {
  it('echoes a plain goal verbatim', () => {
    expect(renderGoalEcho('top 5 hybrid SUVs to buy now for under ,000')).toBe(
      'goal: "top 5 hybrid SUVs to buy now for under ,000"\n',
    );
  });

  it('prints a credential-shaped substring as its placeholder, never the value', () => {
    const line = renderGoalEcho('use key sk-CANARYabcdefghijklmnop to look it up');

    expect(line).not.toContain('sk-CANARYabcdefghijklmnop');
    expect(line).toBe('goal: "use key {{user:api_key:1}} to look it up"\n');
  });

  it('prints a marked value as its placeholder', () => {
    expect(renderGoalEcho('log in with @password{hunter2}')).not.toContain('hunter2');
  });

  it('strips control characters and collapses whitespace', () => {
    expect(renderGoalEcho('find\u001b[2J  cheap\tflights\n\u0085now\u007f')).toBe(
      'goal: "find [2J cheap flights now"\n',
    );
  });

  it('bounds a long goal and states the received length', () => {
    const goal = 'a'.repeat(500);

    const line = renderGoalEcho(goal);

    expect(line).toBe(`goal: "${'a'.repeat(GOAL_ECHO_MAX_CHARS)}…" (500 characters received)\n`);
  });

  it('does not split a surrogate pair when bounding', () => {
    const line = renderGoalEcho('😀'.repeat(250));

    expect(line).toContain(`${'😀'.repeat(GOAL_ECHO_MAX_CHARS)}…`);
    expect(line).not.toContain('\uFFFD');
    expect(line).toContain('(250 characters received)');
  });

  it('escapes embedded quotes and backslashes', () => {
    expect(renderGoalEcho('say "hi" to C:\\temp')).toBe('goal: "say \\"hi\\" to C:\\\\temp"\n');
  });

  it('never prints a goal with a malformed marker, which may hold a secret', () => {
    const line = renderGoalEcho('pw @{hunter2');

    expect(line).not.toContain('hunter2');
    expect(line).toBe('goal: [not shown: the goal has a malformed @{...} marker]\n');
  });

  it('renders an empty goal as an empty quoted string', () => {
    expect(renderGoalEcho('   ')).toBe('goal: ""\n');
  });
});
