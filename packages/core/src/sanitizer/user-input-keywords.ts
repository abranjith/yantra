/**
 * English-anchored, best-effort credential look-around.
 *
 * This detector helps when a user writes `password p1` without an explicit
 * marker. It is defense-in-depth, not a guarantee: regional vocabulary and
 * arbitrary identifiers cannot be inferred reliably. `@{...}` remains the
 * region-agnostic guarantee that a value never reaches the model.
 */

import type { AssignUserInputValue, InputSegment } from './user-input-markers.js';
import type { UserInputValueTag } from './user-input.js';

const KEYWORD_RE =
  /(?<![A-Za-z0-9_])(one[- ]time\s+(?:code|password)|account\s+(?:number|no|#)|social(?:\s+security)?|national\s+id|account\s+name|user\s*id|username|userid|login|password|passwd|pwd|passcode|pass|pin|otp|2fa|mfa|cvv|cvc|ssn|tax\s+id|vin)(?=$|[^A-Za-z0-9_])/gi;
const HIGH_RISK_KEYWORD_RE =
  /(?<![A-Za-z0-9_])(?:password|passwd|pwd|passcode|pin|cvv|cvc|otp)(?=$|[^A-Za-z0-9_])/i;
const CONNECTOR_RE = /^(is|are|of|my|the|for|as)\b/i;
const FOLLOWING_NOUN_STOPLIST = new Set([
  'manager',
  'managers',
  'reset',
  'field',
  'box',
  'prompt',
  'strength',
  'policy',
  'protected',
]);
const HIGH_RISK_KEYWORDS = new Set([
  'password',
  'passwd',
  'pwd',
  'passcode',
  'pin',
  'cvv',
  'cvc',
  'otp',
]);
const COMPLETE_KEYWORDS = new Set([
  'username',
  'user id',
  'userid',
  'login',
  'account',
  'account name',
  'account number',
  'account no',
  'password',
  'passwd',
  'pwd',
  'passcode',
  'pass',
  'pin',
  'otp',
  'one time code',
  'one time password',
  '2fa',
  'mfa',
  'cvv',
  'cvc',
  'ssn',
  'social',
  'social security',
  'national id',
  'tax id',
  'vin',
]);

interface Candidate {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly explicitSeparator: boolean;
}

/** True when text contains an unambiguously high-risk English credential word. */
export function containsHighRiskCredentialKeyword(text: string): boolean {
  return HIGH_RISK_KEYWORD_RE.test(text);
}

/**
 * Detect keyword-adjacent values in literal segments only.
 *
 * The assign callback creates protected value segments. Existing value
 * segments pass through untouched, so this heuristic cannot reclassify or
 * partially consume an explicit marker.
 */
export function detectKeywordValues(
  segments: readonly InputSegment[],
  assign: AssignUserInputValue,
): readonly InputSegment[] {
  return segments.flatMap((segment) =>
    segment.kind === 'literal' ? detectInLiteral(segment.text, assign) : [segment],
  );
}

function detectInLiteral(text: string, assign: AssignUserInputValue): readonly InputSegment[] {
  const output: InputSegment[] = [];
  const pattern = new RegExp(KEYWORD_RE.source, KEYWORD_RE.flags);
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const keyword = match[1]!;
    const tag = tagForKeyword(keyword);
    const candidate = candidateAfter(text, match.index + match[0].length, tag);
    if (candidate === null || candidate.start < cursor || !shouldFire(keyword, candidate)) {
      pattern.lastIndex = Math.max(pattern.lastIndex, match.index + match[0].length);
      continue;
    }
    if (tagForCompleteKeyword(candidate.value) !== null) {
      pattern.lastIndex = candidate.start;
      continue;
    }

    pushLiteral(output, text.slice(cursor, candidate.start));
    output.push(assign(tag, candidate.value));
    cursor = candidate.end;
    pattern.lastIndex = candidate.end;
  }

  pushLiteral(output, text.slice(cursor));
  return output.length > 0 ? output : [{ kind: 'literal', text }];
}

function candidateAfter(
  text: string,
  keywordEnd: number,
  tag: UserInputValueTag,
): Candidate | null {
  let cursor = keywordEnd;
  if (cursor >= text.length || !/[\s:=-]/.test(text[cursor]!)) return null;
  cursor = skipWhitespace(text, cursor);
  let explicitSeparator = false;

  const leadingSeparator = text[cursor];
  if (leadingSeparator === ':' || leadingSeparator === '=' || leadingSeparator === '-') {
    explicitSeparator = leadingSeparator === ':' || leadingSeparator === '=';
    cursor = skipWhitespace(text, cursor + 1);
  }

  for (let count = 0; count < 2; count += 1) {
    const connector = CONNECTOR_RE.exec(text.slice(cursor));
    if (connector === null) break;
    if (connector[1]!.toLowerCase() === 'is') explicitSeparator = true;
    cursor = skipWhitespace(text, cursor + connector[0].length);
  }

  const separator = text[cursor];
  if (separator === ':' || separator === '=' || separator === '-') {
    if (separator === ':' || separator === '=') explicitSeparator = true;
    cursor = skipWhitespace(text, cursor + 1);
  }

  // Natural credential prose commonly inserts a context noun after the two
  // closed-set connectors: "password for my account is x". Treat that final
  // `account is` as context, not as the password candidate itself.
  if (tag === 'password') {
    const contextBridge = /^account\s+is\b/i.exec(text.slice(cursor));
    if (contextBridge !== null) {
      explicitSeparator = true;
      cursor = skipWhitespace(text, cursor + contextBridge[0].length);
    }
  }

  if (cursor >= text.length) return null;
  const quote = text[cursor];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, cursor + 1);
    if (close < 0 || close === cursor + 1) return null;
    return {
      start: cursor + 1,
      end: close,
      value: text.slice(cursor + 1, close),
      explicitSeparator,
    };
  }

  const token = /^[^\s,;]+/.exec(text.slice(cursor))?.[0];
  if (token === undefined) return null;
  const value = token.endsWith('.') ? token.slice(0, -1) : token;
  if (value.length === 0) return null;
  return { start: cursor, end: cursor + value.length, value, explicitSeparator };
}

function shouldFire(keyword: string, candidate: Candidate): boolean {
  const normalizedKeyword = normalizeKeyword(keyword);
  const normalizedValue = candidate.value.toLowerCase();
  if (candidate.explicitSeparator) return true;
  if (/\d/.test(candidate.value)) return true;
  if (/[^A-Za-z0-9]/.test(candidate.value)) return true;
  if (!/^[a-z]+$/.test(candidate.value)) return true;
  return HIGH_RISK_KEYWORDS.has(normalizedKeyword) && !FOLLOWING_NOUN_STOPLIST.has(normalizedValue);
}

function tagForKeyword(keyword: string): UserInputValueTag {
  const normalized = normalizeKeyword(keyword);
  if (
    normalized === 'username' ||
    normalized === 'user id' ||
    normalized === 'userid' ||
    normalized === 'login' ||
    normalized === 'account name'
  ) {
    return 'username';
  }
  if (['password', 'passwd', 'pwd', 'passcode', 'pass'].includes(normalized)) return 'password';
  if (normalized === 'pin') return 'pin';
  if (
    normalized === 'otp' ||
    normalized === '2fa' ||
    normalized === 'mfa' ||
    normalized === 'one time code' ||
    normalized === 'one time password'
  ) {
    return 'otp';
  }
  if (normalized === 'cvv' || normalized === 'cvc') return 'credit_card';
  if (
    normalized === 'ssn' ||
    normalized === 'social' ||
    normalized === 'social security' ||
    normalized === 'national id' ||
    normalized === 'tax id'
  ) {
    return 'national_id';
  }
  if (normalized === 'vin') return 'vin';
  return 'account';
}

function tagForCompleteKeyword(value: string): UserInputValueTag | null {
  const normalized = normalizeKeyword(value);
  return COMPLETE_KEYWORDS.has(normalized) ? tagForKeyword(normalized) : null;
}

function normalizeKeyword(keyword: string): string {
  return keyword.toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1;
  return cursor;
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
