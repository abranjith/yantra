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

export class BrowserSearchError extends SearchProviderError {
  public constructor(
    message: string,
    context: ConstructorParameters<typeof SearchProviderError>[1],
  ) {
    super(message, context);
    this.name = 'BrowserSearchError';
  }
}
