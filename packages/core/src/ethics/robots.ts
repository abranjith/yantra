const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_HOSTS_CACHED = 1024;
const FETCH_TIMEOUT_MS = 5000;

interface CacheEntry {
  readonly parser: RobotsParser;
  readonly expiresAt: number;
  readonly fetchedAt: number;
}

interface RobotsParser {
  isAllowed(url: string, userAgent: string): boolean | undefined;
  getMatchingLineNumber(url: string, userAgent: string): number;
}

/**
 * Fetches and caches robots.txt per host with a 24-hour TTL.
 *
 * Fail-open policy for HTTP 404 (RFC 9309: treat as no restrictions).
 * Fail-closed for timeouts / 5xx (we genuinely don't know — refuse out of honesty).
 */
export class RobotsCacheImpl {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly userAgent: string) {}

  async isAllowed(url: string, userAgent: string): Promise<boolean> {
    const parser = await this.getParser(url);
    if (parser === null) return false; // fail-closed on fetch error
    const allowed = parser.isAllowed(url, userAgent);
    return allowed !== false; // treat undefined (no matching rule) as allowed
  }

  async reasonIfDisallowed(url: string, userAgent: string): Promise<string | null> {
    if (await this.isAllowed(url, userAgent)) return null;
    try {
      const host = new URL(url).hostname;
      return `Disallowed by robots.txt at "${host}"`;
    } catch {
      return 'Disallowed by robots.txt';
    }
  }

  private async getParser(url: string): Promise<RobotsParser | null> {
    const host = extractHost(url);
    const now = Date.now();

    const cached = this.cache.get(host);
    if (cached && cached.expiresAt > now) {
      return cached.parser;
    }

    // Evict oldest entry if at capacity
    if (this.cache.size >= MAX_HOSTS_CACHED) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }

    const robotsUrl = `https://${host}/robots.txt`;
    const parser = await this.fetchRobots(robotsUrl);
    if (parser !== null) {
      this.cache.set(host, { parser, expiresAt: now + ROBOTS_TTL_MS, fetchedAt: now });
    }
    return parser;
  }

  private async fetchRobots(robotsUrl: string): Promise<RobotsParser | null> {
    let content: string;
    let status: number;

    try {
      const result = await fetchWithTimeout(robotsUrl, FETCH_TIMEOUT_MS);
      status = result.status;
      content = result.body;
    } catch {
      // Timeout or network error — try http fallback
      try {
        const httpUrl = robotsUrl.replace('https://', 'http://');
        const result = await fetchWithTimeout(httpUrl, FETCH_TIMEOUT_MS);
        status = result.status;
        content = result.body;
      } catch {
        // Both attempts failed — fail-closed
        return null;
      }
    }

    if (status === 404) {
      // RFC 9309: 404 means no restrictions
      return openRobotsParser();
    }

    if (status !== 200) {
      // 5xx, 403, etc. — fail-closed (honest default)
      return null;
    }

    return parseRobots(robotsUrl, content);
  }
}

// ---------------------------------------------------------------------------
// Minimal robots.txt parser (no external dependency in this module — we use
// the robots-parser package imported dynamically to keep the module testable
// without the package installed)
// ---------------------------------------------------------------------------

async function parseRobots(url: string, content: string): Promise<RobotsParser> {
  try {
    const mod = await import('robots-parser');
    const factory = (mod.default ?? mod) as unknown as (
      url: string,
      content: string,
    ) => RobotsParser;
    return factory(url, content);
  } catch {
    // Fallback: allow everything if the package isn't available
    return openRobotsParser();
  }
}

function openRobotsParser(): RobotsParser {
  return {
    isAllowed: () => true,
    getMatchingLineNumber: () => -1,
  };
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
