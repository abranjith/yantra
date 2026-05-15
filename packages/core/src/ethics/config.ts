import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_USER_AGENT = 'YantraBot/0.1 (+https://yantra.dev)';
const DEFAULT_TOKENS_PER_SECOND = 1;
const DEFAULT_BURST = 2;

export interface HostRateLimit {
  readonly tokensPerSecond: number;
  readonly burst: number;
}

export interface EthicsConfig {
  readonly userAgent: string;
  readonly rateLimitDefault: HostRateLimit;
  readonly rateLimitOverrides: ReadonlyMap<string, HostRateLimit>;
}

export const defaultEthicsConfig: EthicsConfig = {
  userAgent: DEFAULT_USER_AGENT,
  rateLimitDefault: { tokensPerSecond: DEFAULT_TOKENS_PER_SECOND, burst: DEFAULT_BURST },
  rateLimitOverrides: new Map(),
};

/** Loads ethics configuration from `~/.config/yantra/config.yaml`. */
export async function loadEthicsConfig(): Promise<EthicsConfig> {
  const configPath = join(homedir(), '.config', 'yantra', 'config.yaml');
  try {
    const { parse } = await import('yaml');
    const raw = await readFile(configPath, 'utf8');
    const config = parse(raw) as Record<string, unknown>;
    return parseEthicsConfig(config?.ethics as Record<string, unknown> | undefined);
  } catch {
    return defaultEthicsConfig;
  }
}

function parseEthicsConfig(raw: Record<string, unknown> | undefined): EthicsConfig {
  if (!raw) return defaultEthicsConfig;

  const userAgent = typeof raw.user_agent === 'string' ? raw.user_agent : DEFAULT_USER_AGENT;

  const rateLimit = raw.rate_limit as Record<string, unknown> | undefined;
  const rateLimitDefault =
    parseHostRateLimit(rateLimit?.default as Record<string, unknown> | undefined) ??
    defaultEthicsConfig.rateLimitDefault;

  const overridesRaw = rateLimit?.overrides as Record<string, unknown> | undefined;
  const rateLimitOverrides = new Map<string, HostRateLimit>();
  if (overridesRaw) {
    for (const [host, override] of Object.entries(overridesRaw)) {
      const parsed = parseHostRateLimit(override as Record<string, unknown>);
      if (parsed) rateLimitOverrides.set(host, parsed);
    }
  }

  return { userAgent, rateLimitDefault, rateLimitOverrides };
}

function parseHostRateLimit(raw: Record<string, unknown> | undefined): HostRateLimit | null {
  if (!raw) return null;
  const tokensPerSecond =
    typeof raw.tokens_per_second === 'number' ? raw.tokens_per_second : DEFAULT_TOKENS_PER_SECOND;
  const burst = typeof raw.burst === 'number' ? raw.burst : DEFAULT_BURST;
  return { tokensPerSecond, burst };
}
