/**
 * Reversible protection for the user's own run input.
 *
 * Redaction is segment-based: explicit markers become protected value
 * segments, and every later detector is allowed to inspect literal segments
 * only. This makes precedence structural instead of relying on fragile chained
 * string replacements.
 *
 * | Layer | Guarantee | Order |
 * | --- | --- | --- |
 * | `@{...}` / `@tag{...}` markers | absolute | first |
 * | English keyword look-around | best-effort | second |
 * | email/card/phone/API-key/VIN shapes | best-effort | last |
 *
 * Only an explicit marker is a guarantee. Heuristics are defense-in-depth for
 * unmarked values. Raw values remain in one run-scoped vault, resolve only at
 * the tool boundary, and must never be serialized into prompts or artifacts.
 */

import {
  isLuhnValid,
  isStandalonePosition,
  isVinValid,
  SENSITIVE_VALUE_PATTERNS,
} from './strippers.js';
import { detectKeywordValues } from './user-input-keywords.js';
import {
  parseUserInputMarkers,
  type AssignUserInputValue,
  type InputSegment,
} from './user-input-markers.js';

/** Classification tags rendered into placeholder tokens. */
export type UserInputValueTag =
  | 'email'
  | 'phone'
  | 'ssn'
  | 'credit_card'
  | 'api_key'
  | 'auth_param'
  | 'secret'
  | 'username'
  | 'password'
  | 'pin'
  | 'otp'
  | 'national_id'
  | 'vin'
  | 'account'
  | 'dob'
  | 'address';

export { containsUserInputPlaceholder } from './user-input-markers.js';

const PLACEHOLDER_SOURCE = String.raw`\{\{user:([a-z_]+):(\d+)\}\}`;
const PLACEHOLDER_RE = new RegExp(PLACEHOLDER_SOURCE, 'g');

/**
 * Words that mark a nearby bare digit run as a phone number rather than an
 * identifier. These gates are deliberately unchanged from the prior
 * string-based implementation.
 */
const PHONE_CONTEXT_RE =
  /(?:phone|mobile|cell|tel(?:ephone)?|call|text|sms|whatsapp|fax|contact|reach)(?:\W+(?:is|are|was|no|nr|num|number|at|on|me|us|my|our|the|to))*\W*$/i;

/** A number written like a phone: leading `+`, or internal grouping/separators. */
const PHONE_SHAPED_RE = /^\+|[()\s.-]/;

/** Auth-shaped query parameter assignments inside URL-ish literal text. */
const AUTH_PARAM_ASSIGNMENT_RE = new RegExp(
  `([?&](?:${SENSITIVE_VALUE_PATTERNS.authQueryParam.source})=)([^&#\\s"'<>]+)`,
  'gi',
);

interface SegmentMatch {
  readonly start: number;
  readonly length: number;
  readonly tag: UserInputValueTag;
  readonly value: string;
}

interface MaskPart {
  readonly text: string;
  readonly protected: boolean;
}

/**
 * Run-scoped store of user-provided values behind resolvable placeholders.
 * One instance belongs to one agentic run and is never serialized.
 */
export class UserInputVault {
  private readonly valueByPlaceholder = new Map<string, string>();
  private readonly placeholderByValue = new Map<string, string>();
  private readonly countersByTag = new Map<UserInputValueTag, number>();
  private readonly markedValues = new Set<string>();

  /** Number of distinct values currently stored. */
  public get size(): number {
    return this.valueByPlaceholder.size;
  }

  /**
   * Replace user values with indexed placeholders while retaining originals
   * for execution-boundary resolution.
   *
   * Explicit markers are parsed first. Keyword and shape detectors then split
   * literal segments only, so they cannot see, consume, or re-tag a marked
   * value.
   */
  public redact(text: string): string {
    let segments = parseUserInputMarkers(text);

    // Reserve explicit marker identities first. If the same value appears in
    // an earlier shape-detected span, the user's declared tag still wins.
    for (const segment of segments) {
      if (segment.kind !== 'value') continue;
      this.markedValues.add(segment.value);
      this.placeholderFor(segment.tag, segment.value);
    }

    const assign: AssignUserInputValue = (tag, value) => ({ kind: 'value', tag, value });
    segments = detectKeywordValues(segments, assign);

    segments = this.replaceSegments(segments, AUTH_PARAM_ASSIGNMENT_RE, (match) => {
      const value = match[3];
      if (value === undefined) return null;
      return {
        start: match.index + match[0].length - value.length,
        length: value.length,
        tag: 'auth_param',
        value,
      };
    });
    segments = this.replaceDirect(segments, SENSITIVE_VALUE_PATTERNS.email, 'email');
    segments = this.replaceDirect(segments, SENSITIVE_VALUE_PATTERNS.ssn, 'ssn');

    segments = this.replaceSegments(segments, SENSITIVE_VALUE_PATTERNS.cardCandidate, (match) => {
      const candidate = match[0];
      const digits = candidate.replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 19 || !isLuhnValid(digits)) return null;
      return directMatch(match, 'credit_card');
    });

    // Preserve the existing context gate verbatim: an ungrouped 10-15 digit
    // run is more often an order/tracking/account identifier than a phone.
    segments = this.replaceSegments(
      segments,
      SENSITIVE_VALUE_PATTERNS.phoneCandidate,
      (match, whole) => {
        const candidate = match[0];
        const digits = candidate.replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 15) return null;
        if (!isStandalonePosition(whole, match.index, candidate.length)) return null;
        if (
          !PHONE_SHAPED_RE.test(candidate) &&
          !PHONE_CONTEXT_RE.test(whole.slice(0, match.index))
        ) {
          return null;
        }
        return directMatch(match, 'phone');
      },
    );

    segments = this.replaceSegments(
      segments,
      SENSITIVE_VALUE_PATTERNS.vinCandidate,
      (match, whole) => {
        if (!isStandalonePosition(whole, match.index, match[0].length) || !isVinValid(match[0])) {
          return null;
        }
        return directMatch(match, 'vin');
      },
    );

    for (const pattern of SENSITIVE_VALUE_PATTERNS.apiKey) {
      segments = this.replaceDirect(segments, pattern, 'api_key');
    }

    return segments
      .map((segment) =>
        segment.kind === 'literal' ? segment.text : this.placeholderFor(segment.tag, segment.value),
      )
      .join('');
  }

  /**
   * Restore known placeholders to their original values at the tool execution
   * boundary. Unknown model-invented placeholders stay unchanged.
   */
  public resolve(text: string): string {
    if (this.valueByPlaceholder.size === 0) return text;
    return text.replace(new RegExp(PLACEHOLDER_SOURCE, 'g'), (token) => {
      return this.valueByPlaceholder.get(token) ?? token;
    });
  }

  /**
   * Mask raw values echoed by tools back into their stable placeholders.
   *
   * This is defense-in-depth after execution, not the redaction guarantee.
   * Values of eight or more characters are safe to mask as substrings; shorter
   * values use token boundaries to avoid corrupting unrelated page text. Every
   * existing or inserted placeholder is protected from subsequent passes.
   */
  public mask(text: string): string {
    if (this.placeholderByValue.size === 0) return text;
    const entries = [...this.placeholderByValue.entries()].sort(
      (left, right) => right[0].length - left[0].length,
    );
    let parts = protectPlaceholders(text);
    for (const [value, placeholder] of entries) {
      parts = parts.flatMap((part) =>
        part.protected ? [part] : maskValueInPart(part.text, value, placeholder),
      );
    }
    return parts.map((part) => part.text).join('');
  }

  /**
   * Replace known placeholders with durable, non-resolvable descriptions for
   * persistence paths such as promoted workflow YAML.
   */
  public neutralize(text: string): string {
    return text.replace(new RegExp(PLACEHOLDER_SOURCE, 'g'), (token, tag: string) =>
      this.valueByPlaceholder.has(token) ? `[user-provided ${tag}]` : token,
    );
  }

  /** Advisory warnings for marked values whose echoed forms are boundary-only. */
  public warnOnShortValues(): readonly string[] {
    const hasVeryShortMarker = [...this.markedValues].some((value) => [...value].length < 3);
    return hasVeryShortMarker
      ? [
          'A marked value under 3 characters uses boundary-only echo masking and may be missed when a site embeds it inside a larger token.',
        ]
      : [];
  }

  private replaceDirect(
    segments: readonly InputSegment[],
    pattern: RegExp,
    tag: UserInputValueTag,
  ): readonly InputSegment[] {
    return this.replaceSegments(segments, pattern, (match) => directMatch(match, tag));
  }

  private replaceSegments(
    segments: readonly InputSegment[],
    pattern: RegExp,
    select: (match: RegExpExecArray, whole: string) => SegmentMatch | null,
  ): readonly InputSegment[] {
    return segments.flatMap((segment) => {
      if (segment.kind === 'value') return [segment];
      return replaceLiteralMatches(segment.text, pattern, select);
    });
  }

  private placeholderFor(tag: UserInputValueTag, value: string): string {
    const existing = this.placeholderByValue.get(value);
    if (existing !== undefined) return existing;
    const next = (this.countersByTag.get(tag) ?? 0) + 1;
    this.countersByTag.set(tag, next);
    const placeholder = `{{user:${tag}:${next}}}`;
    this.placeholderByValue.set(value, placeholder);
    this.valueByPlaceholder.set(placeholder, value);
    return placeholder;
  }
}

function replaceLiteralMatches(
  text: string,
  pattern: RegExp,
  select: (match: RegExpExecArray, whole: string) => SegmentMatch | null,
): readonly InputSegment[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const scanner = new RegExp(pattern.source, flags);
  const output: InputSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = scanner.exec(text)) !== null) {
    const selected = select(match, text);
    if (selected === null || selected.start < cursor) continue;
    pushLiteral(output, text.slice(cursor, selected.start));
    output.push({ kind: 'value', tag: selected.tag, value: selected.value });
    cursor = selected.start + selected.length;
  }
  pushLiteral(output, text.slice(cursor));
  return output.length > 0 ? output : [{ kind: 'literal', text }];
}

function directMatch(match: RegExpExecArray, tag: UserInputValueTag): SegmentMatch {
  return { start: match.index, length: match[0].length, tag, value: match[0] };
}

function pushLiteral(segments: InputSegment[], text: string): void {
  if (text.length === 0) return;
  const previous = segments.at(-1);
  if (previous?.kind === 'literal') {
    segments[segments.length - 1] = { kind: 'literal', text: previous.text + text };
  } else {
    segments.push({ kind: 'literal', text });
  }
}

function protectPlaceholders(text: string): MaskPart[] {
  const parts: MaskPart[] = [];
  const scanner = new RegExp(PLACEHOLDER_RE.source, 'g');
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    if (match.index > cursor)
      parts.push({ text: text.slice(cursor, match.index), protected: false });
    parts.push({ text: match[0], protected: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length || parts.length === 0) {
    parts.push({ text: text.slice(cursor), protected: false });
  }
  return parts;
}

function maskValueInPart(text: string, value: string, placeholder: string): MaskPart[] {
  if (value.length === 0 || !text.includes(value)) return [{ text, protected: false }];
  const parts: MaskPart[] = [];
  let searchCursor = 0;
  let outputCursor = 0;
  for (;;) {
    const found = text.indexOf(value, searchCursor);
    if (found < 0) break;
    const shouldMask = value.length >= 8 || isStandalonePosition(text, found, value.length);
    if (!shouldMask) {
      searchCursor = found + value.length;
      continue;
    }
    if (found > outputCursor) {
      parts.push({ text: text.slice(outputCursor, found), protected: false });
    }
    parts.push({ text: placeholder, protected: true });
    outputCursor = found + value.length;
    searchCursor = outputCursor;
  }
  if (parts.length === 0) return [{ text, protected: false }];
  if (outputCursor < text.length) {
    parts.push({ text: text.slice(outputCursor), protected: false });
  }
  return parts;
}
