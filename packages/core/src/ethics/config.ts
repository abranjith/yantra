import { loadConfig } from '../config/load.js';

const DEFAULT_USER_AGENT = 'YantraBot/0.1 (+https://yantra.dev)';
const DEFAULT_TOKENS_PER_SECOND = 1;
const DEFAULT_BURST = 2;

export interface HostRateLimit {
  readonly tokensPerSecond: number;
  readonly burst: number;
}

export interface EthicsConfig {
  readonly robotsEnabled: boolean;
  readonly userAgent: string;
  readonly rateLimitDefault: HostRateLimit;
  readonly rateLimitOverrides: ReadonlyMap<string, HostRateLimit>;
}

export const defaultEthicsConfig: EthicsConfig = {
  robotsEnabled: false,
  userAgent: DEFAULT_USER_AGENT,
  rateLimitDefault: { tokensPerSecond: DEFAULT_TOKENS_PER_SECOND, burst: DEFAULT_BURST },
  rateLimitOverrides: new Map(),
};

/** Loads strict, shared configuration and projects the ethics block. */
export async function loadEthicsConfig(): Promise<EthicsConfig> {
  const loaded = await loadConfig();
  if (!loaded.isOk) throw loaded.error;
  const raw = loaded.value.ethics;
  return {
    robotsEnabled: raw.robots_enabled,
    userAgent: raw.user_agent,
    rateLimitDefault: {
      tokensPerSecond: raw.rate_limit.default.tokens_per_second,
      burst: raw.rate_limit.default.burst,
    },
    rateLimitOverrides: new Map(
      Object.entries(raw.rate_limit.overrides).map(([host, value]) => [
        host,
        { tokensPerSecond: value.tokens_per_second, burst: value.burst },
      ]),
    ),
  };
}
