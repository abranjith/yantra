/**
 * Guaranteed user-input marker parsing.
 *
 * Grammar:
 *
 * ```text
 * marker  := "@{" body "}" | "@" tag "{" body "}"
 * tag     := [a-z_]+
 * escape  := "\\" ("{" | "}" | "\\")
 * body    := balanced braces plus escaped characters
 * opt-out := "@@" (renders one literal "@")
 * ```
 *
 * `@` is deliberate: unlike `${...}` it survives bash and PowerShell
 * double-quoted arguments, unlike `#` it does not begin a YAML comment, and
 * unlike `!` it is not subject to bash history expansion. Parsing happens
 * before any model-visible text or run artifact is created.
 */

import type { UserInputValueTag } from './user-input.js';

/** A literal span or a user-declared value that later detectors cannot inspect. */
export type InputSegment =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'value'; readonly tag: UserInputValueTag; readonly value: string };

/** Marker-parse failure categories safe to expose without echoing a value. */
export type UserInputMarkerErrorReason =
  | 'unterminated'
  | 'unknown_tag'
  | 'empty_value'
  | 'value_too_long'
  | 'reserved_placeholder';

/** Assignment callback used by segment detectors to create protected values. */
export type AssignUserInputValue = (tag: UserInputValueTag, value: string) => InputSegment;

/** Public marker tags; `auth_param` remains internal to URL-shape detection. */
export const MARKER_TAGS: ReadonlySet<Exclude<UserInputValueTag, 'auth_param'>> = new Set([
  'email',
  'phone',
  'ssn',
  'credit_card',
  'api_key',
  'secret',
  'username',
  'password',
  'pin',
  'otp',
  'national_id',
  'vin',
  'account',
  'dob',
  'address',
]);

const USER_INPUT_PLACEHOLDER_RE = /\{\{user:[a-z_]+:\d+\}\}/;
const MAX_MARKED_VALUE_LENGTH = 2048;

/** True when text contains the reserved `{{user:tag:N}}` namespace. */
export function containsUserInputPlaceholder(text: string): boolean {
  return USER_INPUT_PLACEHOLDER_RE.test(text);
}

/**
 * A safe, actionable marker syntax error.
 *
 * The error exposes only a source offset, its 1-based column, and a reason; it
 * never includes the marked value or its length.
 */
export class UserInputMarkerError extends Error {
  public readonly column: number;

  public constructor(
    public readonly offset: number,
    public readonly reason: UserInputMarkerErrorReason,
  ) {
    const column = offset + 1;
    super(messageFor(reason, column));
    this.name = 'UserInputMarkerError';
    this.column = column;
  }
}

/**
 * Parse explicit `@{...}` / `@tag{...}` markers into protected segments.
 *
 * Balanced braces are supported, `\{`, `\}`, and `\\` escape their following
 * character, and nested marker-looking text remains part of the outer value.
 * Unknown tags and malformed markers fail closed with a
 * {@link UserInputMarkerError}.
 */
export function parseUserInputMarkers(text: string): readonly InputSegment[] {
  const reservedOffset = text.search(USER_INPUT_PLACEHOLDER_RE);
  if (reservedOffset >= 0) {
    throw new UserInputMarkerError(reservedOffset, 'reserved_placeholder');
  }

  const segments: InputSegment[] = [];
  let literal = '';
  let cursor = 0;

  const flushLiteral = (): void => {
    if (literal.length === 0) return;
    pushLiteral(segments, literal);
    literal = '';
  };

  while (cursor < text.length) {
    if (text[cursor] !== '@') {
      literal += text[cursor];
      cursor += 1;
      continue;
    }

    if (text[cursor + 1] === '@') {
      literal += '@';
      cursor += 2;
      continue;
    }

    const marker = markerOpeningAt(text, cursor);
    if (marker === null) {
      literal += '@';
      cursor += 1;
      continue;
    }
    if (marker.tag === 'auth_param' || !MARKER_TAGS.has(marker.tag)) {
      throw new UserInputMarkerError(cursor, 'unknown_tag');
    }

    flushLiteral();
    const valueStart = marker.openBraceOffset + 1;
    let bodyCursor = valueStart;
    let depth = 1;
    let value = '';

    while (bodyCursor < text.length && depth > 0) {
      const character = text[bodyCursor]!;
      if (character === '\\') {
        const escaped = text[bodyCursor + 1];
        if (escaped === '{' || escaped === '}' || escaped === '\\') {
          value += escaped;
          bodyCursor += 2;
        } else {
          value += '\\';
          bodyCursor += 1;
        }
        continue;
      }
      if (character === '{') {
        depth += 1;
        value += character;
        bodyCursor += 1;
        continue;
      }
      if (character === '}') {
        depth -= 1;
        bodyCursor += 1;
        if (depth > 0) value += character;
        continue;
      }
      value += character;
      bodyCursor += 1;
    }

    if (depth > 0) throw new UserInputMarkerError(cursor, 'unterminated');
    if (value.trim().length === 0) throw new UserInputMarkerError(cursor, 'empty_value');
    if (value.length > MAX_MARKED_VALUE_LENGTH) {
      throw new UserInputMarkerError(cursor, 'value_too_long');
    }

    segments.push({ kind: 'value', tag: marker.tag, value });
    cursor = bodyCursor;
  }

  flushLiteral();
  return segments;
}

function markerOpeningAt(
  text: string,
  offset: number,
): { readonly tag: UserInputValueTag; readonly openBraceOffset: number } | null {
  if (text[offset + 1] === '{') {
    return { tag: 'secret', openBraceOffset: offset + 1 };
  }

  const tagged = /^([a-z_]+)\{/.exec(text.slice(offset + 1));
  if (tagged === null) return null;
  const tag = tagged[1]! as UserInputValueTag;
  return { tag, openBraceOffset: offset + 1 + tag.length };
}

function pushLiteral(segments: InputSegment[], text: string): void {
  const previous = segments.at(-1);
  if (previous?.kind === 'literal') {
    segments[segments.length - 1] = { kind: 'literal', text: previous.text + text };
  } else {
    segments.push({ kind: 'literal', text });
  }
}

function messageFor(reason: UserInputMarkerErrorReason, column: number): string {
  switch (reason) {
    case 'unterminated':
      return `Unterminated user-input marker at column ${column} — close it with \`}\`, or write \`@@{\` for a literal \`@{\`.`;
    case 'unknown_tag':
      return `Unknown user-input marker tag at column ${column} — use a supported tag, \`@{...}\` for a generic secret, or \`@@{\` for a literal \`@{\`.`;
    case 'empty_value':
      return `Empty user-input marker at column ${column} — put a non-whitespace value between the braces.`;
    case 'value_too_long':
      return `User-input marker at column ${column} is too long — marked values may contain at most 2048 characters.`;
    case 'reserved_placeholder':
      return `Reserved user-input placeholder at column ${column} — do not type \`{{user:...}}\` tokens directly; use \`@{...}\` instead.`;
  }
}
