/**
 * The goal echo (FEAT-048): one stderr line stating the goal exactly as Yantra
 * received it, so a shell that rewrote the argument is visible in the first
 * second of a run. Two earlier runs recorded "top 5 hybrid SUVs to buy now for
 * under ,000": the shell had expanded `$40` before Yantra saw it, and nothing
 * showed the user. The echo makes the problem visible; it never guesses at a
 * fix, because the user is the one who knows what they typed.
 *
 * `ask`, `research`, and `do` print it with identical spelling (memory → CLI
 * UX consistency). It goes to stderr only, so `--json` stdout is untouched.
 */

import { redactRunInput, UserInputMarkerError } from '@yantra/core';
import type { RunEventOf } from '@yantra/protocol';

/** The echo shows at most this many characters of the goal. */
export const GOAL_ECHO_MAX_CHARS = 200;

// C0 controls, DEL, and C1 controls: a goal can carry escape sequences that
// would rewrite the terminal line being printed.
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/gu;

/**
 * Removes C0/C1 control characters (so no escape sequence reaches the
 * terminal) and collapses whitespace to single spaces. Shared by every stderr
 * echo line: the goal echo and the task-contract echo.
 */
export function stripControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARS_RE, ' ').replace(/\s+/gu, ' ').trim();
}

/**
 * The goal-echo event (FEAT-063): the echo line without its newline, plus how
 * much goal was received and whether the line shows only its start. The run's
 * renderers print `display`; the run-event log records the event.
 *
 * 1. Credential-shaped and marked values print as their placeholders
 *    (`redactRunInput`), exactly as the run itself will see them.
 * 2. Control characters are removed and whitespace collapsed.
 * 3. The text is bounded to {@link GOAL_ECHO_MAX_CHARS} characters; a cut goal
 *    ends with `…` and states the received length.
 * 4. Quotes and backslashes are escaped so the quoted text is unambiguous.
 *
 * Total: a goal with malformed `@{…}` markers (which the command rejects with
 * its own validation error) is reported as not shown rather than printed raw,
 * because an unclosed marker may hold a secret.
 *
 * @param goal The goal argument as received.
 * @param at Emission timestamp; defaults to now.
 */
export function goalEchoEvent(
  goal: string,
  at: string = new Date().toISOString(),
): RunEventOf<'goal_echo'> {
  const receivedChars = [...goal].length;
  let redacted: string;
  try {
    redacted = redactRunInput({ goal }).goal;
  } catch (error) {
    if (error instanceof UserInputMarkerError) {
      return {
        kind: 'goal_echo',
        display: 'goal: [not shown: the goal has a malformed @{...} marker]',
        received_chars: receivedChars,
        truncated: false,
        at,
      };
    }
    throw error;
  }
  const cleaned = stripControlCharacters(redacted);
  const chars = [...cleaned];
  const truncated = chars.length > GOAL_ECHO_MAX_CHARS;
  const bounded = truncated ? `${chars.slice(0, GOAL_ECHO_MAX_CHARS).join('')}…` : cleaned;
  const escaped = bounded.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
  const suffix = truncated ? ` (${receivedChars} characters received)` : '';
  return {
    kind: 'goal_echo',
    display: `goal: "${escaped}"${suffix}`,
    received_chars: receivedChars,
    truncated,
    at,
  };
}

/**
 * Render the goal-echo line: {@link goalEchoEvent}'s `display` plus a newline.
 *
 * @param goal The goal argument as received.
 * @returns One line, newline-terminated: `goal: "<text>"`.
 */
export function renderGoalEcho(goal: string): string {
  return `${goalEchoEvent(goal).display}\n`;
}
