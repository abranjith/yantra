/**
 * Outbound URL policy (FEAT-024 TASK-001, plan_agentic.md §8.13).
 *
 * Outbound URLs (`web_fetch` here, `browser_navigate` in FEAT-025) are the
 * acknowledged injection-exfiltration channel: prompt-injected page content can
 * *request* a fetch, but it must never make one invisibly or unboundedly. Every
 * candidate URL is therefore:
 *
 *   1. length-capped (a smuggled payload cannot be arbitrarily long);
 *   2. required to be http(s) — and https unless explicitly relaxed;
 *   3. scanned for credential-shaped substrings (the same shapes the lint and
 *      sanitizer recognise: `sk-`, `ghp_`, `AKIA`, `eyJ…` JWTs);
 *   4. counted against the run's per-host / navigation budget (a new host both
 *      decrements the host budget and is audited in full).
 *
 * Every decision — allow or reject — is recorded in full so the audit trail
 * shows exactly which outbound URLs the agent attempted (plan §8.13). The policy
 * never throws; callers receive a typed {@link UrlPolicyRejection} and surface a
 * stable tool error.
 */

import type { Result } from '@yantra/protocol';
import { err, ok } from '@yantra/protocol';

import type { BudgetDecision, BudgetTracker } from './budget.js';

/**
 * Credential shapes scanned inside outbound URLs. Deliberately the canonical
 * set shared with the workflow lint rule so "what counts as a credential" has a
 * single definition across the codebase.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AKIA[A-Z0-9]{16}/,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
];

/** Stable machine codes for URL policy rejections. */
export type UrlPolicyErrorCode =
  | 'URL_INVALID'
  | 'URL_TOO_LONG'
  | 'URL_INSECURE'
  | 'URL_CREDENTIAL_SHAPE'
  | 'URL_HOST_NOT_ALLOWED'
  | 'BUDGET_EXHAUSTED'
  /** The URL was not produced by any tool result this run — see `UrlProvenance`. */
  | 'URL_NOT_FROM_EVIDENCE';

/** A typed, render-safe URL rejection. Never contains the offending secret. */
export interface UrlPolicyRejection {
  /** Stable machine code. */
  readonly code: UrlPolicyErrorCode;
  /** Secret-free explanation suitable for the model and audit. */
  readonly message: string;
  /** Whether retrying with a corrected URL could succeed. */
  readonly retryable: boolean;
}

/** A URL that passed every policy check. */
export interface AllowedUrl {
  /** The normalized absolute URL. */
  readonly url: string;
  /** Lowercased hostname. */
  readonly host: string;
}

/** One audited outbound-URL decision. */
export interface UrlAuditRecord {
  /** Full URL as evaluated (audited in full per §8.13). */
  readonly url: string;
  /** Lowercased hostname, when parseable. */
  readonly host: string | null;
  /** Outcome of the policy evaluation. */
  readonly decision: 'allow' | 'reject';
  /** Rejection code when `decision` is `reject`. */
  readonly code?: UrlPolicyErrorCode;
}

/** Sink receiving every outbound-URL decision for the run audit. */
export interface UrlAuditSink {
  record(entry: UrlAuditRecord): void;
}

/** Configuration for {@link UrlPolicy}. */
export interface UrlPolicyConfig {
  /** Maximum URL length in characters. */
  readonly maxUrlLength: number;
  /** Require https (reject plain http). */
  readonly requireHttps: boolean;
  /** Optional explicit host allowlist for this run. */
  readonly allowedHosts?: readonly string[];
}

/** Default URL policy: 2 KB cap, https-only. */
export const DEFAULT_URL_POLICY_CONFIG: UrlPolicyConfig = {
  maxUrlLength: 2048,
  requireHttps: true,
};

/**
 * Validates outbound URLs against the §8.13 controls and decrements the run's
 * host budget for new hosts.
 */
export class UrlPolicy {
  /**
   * @param budgets Run budget tracker (host/navigation decrement).
   * @param config Length/scheme configuration.
   * @param auditSink Optional sink; every decision is recorded when present.
   */
  public constructor(
    private readonly budgets: BudgetTracker,
    private readonly config: UrlPolicyConfig = DEFAULT_URL_POLICY_CONFIG,
    private readonly auditSink?: UrlAuditSink,
  ) {}

  /**
   * Evaluate one candidate outbound URL.
   *
   * @param rawUrl The URL the agent (or page content) asked to reach.
   * @returns `ok(allowed)` after the host budget is decremented, or
   *   `err(rejection)` with a stable code. Both outcomes are audited in full.
   */
  public check(rawUrl: string): Result<AllowedUrl, UrlPolicyRejection> {
    // Length is checked on the raw string first — an over-long URL is rejected
    // before we spend effort parsing it, and before any substring scan.
    if (rawUrl.length > this.config.maxUrlLength) {
      return this.reject(rawUrl, null, {
        code: 'URL_TOO_LONG',
        message: `URL exceeds the ${this.config.maxUrlLength}-character limit.`,
        retryable: false,
      });
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return this.reject(rawUrl, null, {
        code: 'URL_INVALID',
        message: 'URL is not a valid absolute URL.',
        retryable: true,
      });
    }

    const host = parsed.hostname.toLowerCase();
    const scheme = parsed.protocol.toLowerCase();

    if (scheme !== 'http:' && scheme !== 'https:') {
      return this.reject(rawUrl, host, {
        code: 'URL_INSECURE',
        message: `Only http(s) URLs are allowed; got "${scheme.replace(':', '')}".`,
        retryable: false,
      });
    }
    if (this.config.requireHttps && scheme !== 'https:') {
      return this.reject(rawUrl, host, {
        code: 'URL_INSECURE',
        message: 'Only https URLs are allowed.',
        retryable: false,
      });
    }
    if (
      this.config.allowedHosts !== undefined &&
      !this.config.allowedHosts.some((allowed) => hostMatches(host, allowed))
    ) {
      return this.reject(rawUrl, host, {
        code: 'URL_HOST_NOT_ALLOWED',
        message: `Host "${host}" is outside this run's allowed hosts.`,
        retryable: false,
      });
    }

    // Credential-shape scan across the whole URL (path, query, fragment). A hit
    // means the URL is smuggling something that looks like a secret out — refuse
    // structurally, never echoing the matched substring.
    if (CREDENTIAL_SHAPES.some((pattern) => pattern.test(rawUrl))) {
      return this.reject(rawUrl, host, {
        code: 'URL_CREDENTIAL_SHAPE',
        message: 'URL contains a credential-shaped substring and was refused.',
        retryable: false,
      });
    }

    const reserved = this.budgets.reserveNavigation(host);
    if (!reserved.isOk) {
      return this.reject(rawUrl, host, budgetRejection(reserved.error));
    }

    this.auditSink?.record({ url: rawUrl, host, decision: 'allow' });
    return ok({ url: parsed.toString(), host });
  }

  private reject(
    url: string,
    host: string | null,
    rejection: UrlPolicyRejection,
  ): Result<AllowedUrl, UrlPolicyRejection> {
    this.auditSink?.record({ url, host, decision: 'reject', code: rejection.code });
    return err(rejection);
  }
}

function hostMatches(host: string, allowed: string): boolean {
  const normalized = allowed.trim().toLowerCase().split(':')[0] ?? '';
  return normalized.length > 0 && (host === normalized || host.endsWith(`.${normalized}`));
}

/** Map a budget exhaustion into a URL policy rejection (never retryable). */
function budgetRejection(decision: BudgetDecision): UrlPolicyRejection {
  return { code: 'BUDGET_EXHAUSTED', message: decision.message, retryable: false };
}
