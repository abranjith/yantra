import type { SearchProviderName } from '../types.js';

export class SearchProviderError extends Error {
  public constructor(
    message: string,
    public readonly context: {
      readonly provider: SearchProviderName;
      readonly statusCode?: number;
      readonly host?: string;
      readonly retryAfter?: string | null;
      readonly code?: string;
    },
  ) {
    super(message);
    this.name = 'SearchProviderError';
  }
}

export class TavilyAuthError extends SearchProviderError {
  public constructor(
    message: string,
    context: ConstructorParameters<typeof SearchProviderError>[1],
  ) {
    super(message, context);
    this.name = 'TavilyAuthError';
  }
}

export class RateLimitError extends SearchProviderError {
  public constructor(
    message: string,
    context: ConstructorParameters<typeof SearchProviderError>[1],
  ) {
    super(message, context);
    this.name = 'RateLimitError';
  }
}

/**
 * Raised by scraped providers (google/duckduckgo) when a SERP fetch fails —
 * ethics refusal, anti-bot anomaly/CAPTCHA interstitial, empty results, or a
 * transport error. The `context.code` discriminates the specific cause
 * (`ethics-refused:*`, `anomaly-challenge`, `empty-results`, `aborted`).
 */
export class ScrapeSearchError extends SearchProviderError {
  public constructor(
    message: string,
    context: ConstructorParameters<typeof SearchProviderError>[1],
  ) {
    super(message, context);
    this.name = 'ScrapeSearchError';
  }
}

/**
 * Raised when a provider is selected explicitly (via flag, env, or config) but
 * its required API key is missing from the keychain. Unlike the old
 * warn-and-fall-back behavior, explicit selection fails hard so misconfiguration
 * is visible. Carries an actionable hint pointing at `yantra init` / keychain
 * setup.
 */
export class SearchProviderKeyMissingError extends SearchProviderError {
  public constructor(
    public readonly provider: SearchProviderName,
    public readonly keychainAccount: string,
  ) {
    super(
      `Search provider "${provider}" requires an API key, but "${keychainAccount}" is not in the ` +
        `keychain. Run \`yantra init\` to seed it, or store it manually under the "yantra" service. ` +
        `Alternatively pick a key-free provider (\`--search-provider duckduckgo\`) or \`auto\`.`,
      { provider, code: 'key-missing' },
    );
    this.name = 'SearchProviderKeyMissingError';
  }
}

/**
 * Raised when `auto` resolution walks the entire fallback chain without finding
 * a usable provider — every candidate was a keyed API provider whose key is
 * missing, and no key-free scraped provider was in the chain. Explains what to
 * configure to recover.
 */
export class NoSearchProviderAvailableError extends SearchProviderError {
  public constructor(public readonly chain: readonly SearchProviderName[]) {
    super(
      `No search provider is available. The fallback chain [${chain.join(', ')}] was exhausted: ` +
        `every candidate needs an API key that is not in the keychain. Seed a key with ` +
        `\`yantra init\`, or add a key-free provider (e.g. \`duckduckgo\`) to \`search.fallback_chain\`.`,
      { provider: chain[chain.length - 1] ?? 'duckduckgo', code: 'no-provider-available' },
    );
    this.name = 'NoSearchProviderAvailableError';
  }
}

/**
 * Raised when a provider selection references a name that is not registered.
 * Config values are Zod-validated at load, so this guards programmatic misuse.
 */
export class UnknownSearchProviderError extends SearchProviderError {
  public constructor(public readonly requested: string) {
    super(
      `Unknown search provider "${String(requested)}". Expected one of: ` +
        `google, duckduckgo, brave, tavily (or "auto").`,
      { provider: 'duckduckgo', code: 'unknown-provider' },
    );
    this.name = 'UnknownSearchProviderError';
  }
}
