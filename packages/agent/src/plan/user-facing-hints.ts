/**
 * Maps dominant ValidationError.code values to a one-line user-facing hint.
 *
 * When generatePlan exhausts re-prompts, the orchestrator classifies the most
 * common code across collected attempts and selects a hint from this table.
 */
export const USER_FACING_HINTS: Readonly<Record<string, string>> = {
  unknown_locator:
    "the AI referenced a UI element the workflow doesn't define — try naming the target more concretely",
  scope_violation:
    'the AI tried to perform a mutating action inside a `read-only-data` section — try splitting the task into read and write phases',
  undeclared_secret:
    'the AI needs a credential not yet stored — run `yantra config set secret.<name>` first',
  missing_param:
    "the AI needs a value you didn't provide — re-run with `--params <key>=<value>` for the missing field",
  capture_step_not_extract:
    'the AI referenced a capture from a non-extract step — review the plan structure',
  unknown_capture_step: "the AI referenced a capture step that doesn't exist in the plan",
  capture_must_reference_prior_step:
    'the AI referenced a future capture — all capture references must point to prior steps',
  duplicate_step_id: 'the AI produced duplicate step IDs — the plan structure is malformed',
  unknown_then_step: "the AI referenced a branch target step that doesn't exist in the plan",
  unknown_else_step: "the AI referenced a branch else-target step that doesn't exist in the plan",
  unknown_loop_body_step: "the AI referenced a loop body step that doesn't exist in the plan",
  capture_field_missing:
    "the AI referenced an extraction field that the extract schema doesn't define",
};

/**
 * Returns a user-facing hint for the dominant error code, or a generic fallback.
 */
export function resolveUserFacingHint(dominantCode: string | null): string {
  if (dominantCode !== null && dominantCode in USER_FACING_HINTS) {
    return USER_FACING_HINTS[dominantCode]!;
  }
  return "the AI couldn't structure a valid plan — try rephrasing your request more concretely with specific URLs or named elements";
}

/**
 * Finds the most frequent error code across a list of ValidationErrors.
 */
export function dominantErrorCode(errors: readonly { code: string }[]): string | null {
  if (errors.length === 0) {
    return null;
  }

  const counts = new Map<string, number>();
  for (const e of errors) {
    counts.set(e.code, (counts.get(e.code) ?? 0) + 1);
  }

  let maxCode: string | null = null;
  let maxCount = 0;
  for (const [code, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      maxCode = code;
    }
  }

  return maxCode;
}
