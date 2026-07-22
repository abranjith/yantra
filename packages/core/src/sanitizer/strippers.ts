import { load } from 'cheerio';

export interface TransformResult {
  readonly text: string;
  readonly hits: number;
}

const AUTH_QUERY_PARAM_RE = /(token|access_token|api_key|session|auth|sid|jwt)/i;
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>]+/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g;
const PHONE_CANDIDATE_RE = /\+?\d[\d()\s.-]{8,}\d/g;
const CURRENCY_USD_RE = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g;
const DATE_OF_BIRTH_RE =
  /\b(?:19|20)\d{2}[/-](?:0[1-9]|1[0-2])[/-](?:0[1-9]|[12]\d|3[01])\b|\b(?:0[1-9]|1[0-2])[/-](?:0[1-9]|[12]\d|3[01])[/-](?:19|20)\d{2}\b/g;
const CASE_NUMBER_RE = /\b[A-Z]{1,4}-?\d{6,12}\b/g;
const TRAILING_PUNCTUATION_RE = /[),.;!?]+$/;

const API_KEY_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxoxb-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

// Context-anchored production redactors for per-host overrides. Each requires a
// labelling keyword (or an unambiguous format such as IBAN/EIN) so ordinary
// prose numbers are not swallowed — over-redaction breaks task functionality.
const ACCOUNT_NUMBER_RE = /\b(?:account|acct|a\/c)\s*(?:no\.?|number|#|id)?\s*[:#]?\s*\d{6,17}\b/gi;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
const MEMBER_ID_RE =
  /\b(?:member|policy|group|subscriber)\s*(?:id|no\.?|number|#)\s*[:#]?\s*[A-Za-z0-9][A-Za-z0-9-]{4,19}\b/gi;
const MEDICAL_RECORD_NUMBER_RE =
  /\b(?:mrn|medical\s*record\s*(?:no\.?|number))\s*[:#]?\s*[A-Za-z0-9][A-Za-z0-9-]{3,14}\b/gi;
const TAX_ID_RE = /\b\d{2}-\d{7}\b/g;
const PASSPORT_NUMBER_RE =
  /\bpassport\s*(?:no\.?|number|#)?\s*[:#]?\s*(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,9}\b/gi;
const DRIVERS_LICENSE_RE =
  /\b(?:driver'?s?\s*licen[cs]e|dl)\s*(?:no\.?|number|#)?\s*[:#]?\s*(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{4,20}\b/gi;

/**
 * Shared sensitive-value detection patterns. Reused by the user-input vault so
 * goal/profile-context redaction and payload sanitization agree on what counts
 * as a sensitive shape. The regexes carry stateful flags — consumers must
 * construct a fresh `RegExp` from `.source` rather than reusing these directly.
 */
export const SENSITIVE_VALUE_PATTERNS = Object.freeze({
  email: EMAIL_RE,
  ssn: SSN_RE,
  cardCandidate: CARD_CANDIDATE_RE,
  phoneCandidate: PHONE_CANDIDATE_RE,
  apiKey: API_KEY_PATTERNS,
  authQueryParam: AUTH_QUERY_PARAM_RE,
});

/**
 * Remove input-like value content while preserving element structure.
 */
export function stripFormValues(html: string): TransformResult {
  const $ = load(html, undefined, false);
  let hits = 0;

  $('input[value]').each((_, element) => {
    const current = $(element).attr('value');
    if (current !== undefined) {
      hits += 1;
    }
    $(element).attr('value', '');
  });

  $('textarea').each((_, element) => {
    if ($(element).text().length > 0) {
      hits += 1;
    }
    $(element).text('');
  });

  $('[contenteditable]').each((_, element) => {
    if ($(element).text().length > 0) {
      hits += 1;
    }
    $(element).text('');
  });

  return {
    text: $.html(),
    hits,
  };
}

/**
 * Remove all query strings from URLs in arbitrary text.
 */
export function stripQueryStrings(text: string): TransformResult {
  let hits = 0;

  const rewritten = rewriteUrlsInText(text, (url) => {
    if (!url.search) {
      return url.toString();
    }
    url.search = '';
    hits += 1;
    return url.toString();
  });

  const fallback = rewritten.text.replace(/\?([^#\s]+)/g, (_full) => {
    hits += 1;
    return '';
  });

  return {
    text: fallback,
    hits,
  };
}

/**
 * Remove auth-like query params while preserving benign query fields.
 */
export function stripAuthQueryParams(text: string): TransformResult {
  let hits = 0;

  const rewritten = rewriteUrlsInText(text, (url) => {
    const paramNames = [...url.searchParams.keys()];
    for (const key of paramNames) {
      if (AUTH_QUERY_PARAM_RE.test(key)) {
        url.searchParams.delete(key);
        hits += 1;
      }
    }
    return url.toString();
  });

  const fallback = rewritten.text.replace(/\?([^#\s]+)/g, (full, query: string) => {
    const pairs = query.split('&').filter((pair) => pair.length > 0);
    const kept = pairs.filter((pair) => {
      const [rawKey = ''] = pair.split('=');
      if (AUTH_QUERY_PARAM_RE.test(rawKey)) {
        hits += 1;
        return false;
      }
      return true;
    });

    if (kept.length === 0) {
      return '';
    }

    return `?${kept.join('&')}`;
  });

  return {
    text: fallback,
    hits,
  };
}

export function redactEmails(text: string): TransformResult {
  return replaceWithRegex(text, EMAIL_RE, '[redacted-email]');
}

export function redactSsn(text: string): TransformResult {
  return replaceWithRegex(text, SSN_RE, '[redacted-ssn]');
}

export function redactCreditCards(text: string): TransformResult {
  let hits = 0;
  const redacted = text.replace(CARD_CANDIDATE_RE, (candidate) => {
    const digits = candidate.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) {
      return candidate;
    }
    if (!isLuhnValid(digits)) {
      return candidate;
    }
    hits += 1;
    return '[redacted-credit-card]';
  });

  return { text: redacted, hits };
}

export function redactPhones(text: string): TransformResult {
  let hits = 0;
  const redacted = text.replace(PHONE_CANDIDATE_RE, (candidate) => {
    const digits = candidate.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      return candidate;
    }
    hits += 1;
    return '[redacted-phone]';
  });

  return { text: redacted, hits };
}

export function redactApiKeyShapes(text: string): TransformResult {
  let current = text;
  let hits = 0;

  for (const pattern of API_KEY_PATTERNS) {
    const result = replaceWithRegex(current, pattern, '[redacted-api-key]');
    current = result.text;
    hits += result.hits;
  }

  return {
    text: current,
    hits,
  };
}

export function redactCurrencyUsd(text: string): TransformResult {
  return replaceWithRegex(text, CURRENCY_USD_RE, '[redacted-currency-usd]');
}

export function redactDateOfBirth(text: string): TransformResult {
  return replaceWithRegex(text, DATE_OF_BIRTH_RE, '[redacted-date-of-birth]');
}

export function redactCaseNumber(text: string): TransformResult {
  return replaceWithRegex(text, CASE_NUMBER_RE, '[redacted-case-number]');
}

export function redactAccountNumber(text: string): TransformResult {
  return replaceWithRegex(text, ACCOUNT_NUMBER_RE, '[redacted-account-number]');
}

export function redactIban(text: string): TransformResult {
  return replaceWithRegex(text, IBAN_RE, '[redacted-iban]');
}

export function redactMemberId(text: string): TransformResult {
  return replaceWithRegex(text, MEMBER_ID_RE, '[redacted-member-id]');
}

export function redactMedicalRecordNumber(text: string): TransformResult {
  return replaceWithRegex(text, MEDICAL_RECORD_NUMBER_RE, '[redacted-medical-record-number]');
}

export function redactTaxId(text: string): TransformResult {
  return replaceWithRegex(text, TAX_ID_RE, '[redacted-tax-id]');
}

export function redactPassportNumber(text: string): TransformResult {
  return replaceWithRegex(text, PASSPORT_NUMBER_RE, '[redacted-passport-number]');
}

export function redactDriversLicense(text: string): TransformResult {
  return replaceWithRegex(text, DRIVERS_LICENSE_RE, '[redacted-drivers-license]');
}

export function isLuhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;

  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i]);

    if (shouldDouble) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }

    sum += value;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

function replaceWithRegex(text: string, regex: RegExp, replacement: string): TransformResult {
  let hits = 0;
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const pattern = new RegExp(regex.source, flags);

  const transformed = text.replace(pattern, () => {
    hits += 1;
    return replacement;
  });

  return {
    text: transformed,
    hits,
  };
}

function rewriteUrlsInText(
  text: string,
  rewrite: (url: URL) => string,
): { text: string; hits: number } {
  let hits = 0;

  const rewritten = text.replace(URL_IN_TEXT_RE, (rawToken) => {
    const { token, suffix } = splitTrailingPunctuation(rawToken);

    try {
      const url = new URL(token);
      const replaced = rewrite(url);
      if (replaced !== token) {
        hits += 1;
      }
      return `${replaced}${suffix}`;
    } catch {
      return rawToken;
    }
  });

  return {
    text: rewritten,
    hits,
  };
}

function splitTrailingPunctuation(token: string): { token: string; suffix: string } {
  const match = TRAILING_PUNCTUATION_RE.exec(token);
  if (!match) {
    return { token, suffix: '' };
  }

  const suffix = match[0];
  return {
    token: token.slice(0, token.length - suffix.length),
    suffix,
  };
}
