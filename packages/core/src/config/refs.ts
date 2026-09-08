import { err, ok, type Result } from '@yantra/protocol';

import type { KeychainProvider } from '../secrets/keychain.js';
import { YANTRA_KEYCHAIN_SERVICE } from '../secrets/keychain.js';

export type ConfigRef =
  | { readonly kind: 'env'; readonly name: string }
  | { readonly kind: 'secret'; readonly key: string };

const ENV_REF = /^\$\{env:([A-Z_][A-Z0-9_]*)\}$/u;
const SECRET_REF = /^\$\{secret:([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)\}$/u;

export function parseConfigRef(raw: string): Result<ConfigRef, string> {
  const env = ENV_REF.exec(raw);
  if (env?.[1]) return ok({ kind: 'env', name: env[1] });
  const secret = SECRET_REF.exec(raw);
  if (secret?.[1]) return ok({ kind: 'secret', key: secret[1] });
  return err(`invalid configuration reference "${raw}"`);
}

export function formatConfigRef(ref: ConfigRef): string {
  return ref.kind === 'env' ? `\${env:${ref.name}}` : `\${secret:${ref.key}}`;
}

export class ConfigRefError extends Error {
  public constructor(
    message: string,
    public readonly reference: string,
    public readonly reason: 'missing-env' | 'missing-secret' | 'keychain-unavailable',
  ) {
    super(message);
    this.name = 'ConfigRefError';
  }
}

export interface ConfigRefResolverDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly keychain: KeychainProvider;
  readonly keychainService?: string;
}

export async function resolveConfigRef(
  ref: ConfigRef,
  deps: ConfigRefResolverDeps,
): Promise<Result<string, ConfigRefError>> {
  const rendered = formatConfigRef(ref);
  if (ref.kind === 'env') {
    const value = deps.env[ref.name];
    return value
      ? ok(value)
      : err(
          new ConfigRefError(
            `Environment variable ${ref.name} is not set.`,
            rendered,
            'missing-env',
          ),
        );
  }

  if (!(await deps.keychain.isAvailable())) {
    return err(
      new ConfigRefError(
        `The OS keychain is unavailable while resolving ${rendered}.`,
        rendered,
        'keychain-unavailable',
      ),
    );
  }
  const value = await deps.keychain.get(deps.keychainService ?? YANTRA_KEYCHAIN_SERVICE, ref.key);
  return value
    ? ok(value)
    : err(
        new ConfigRefError(`No keychain entry exists for ${ref.key}.`, rendered, 'missing-secret'),
      );
}

/** Converts parsed references back to safe reference text for display/logging. */
export function redactConfigRefs<T>(value: T): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactConfigRefs(entry));
  if (value && typeof value === 'object') {
    const candidate = value as Partial<ConfigRef>;
    if (candidate.kind === 'env' && typeof candidate.name === 'string') {
      return formatConfigRef({ kind: 'env', name: candidate.name });
    }
    if (candidate.kind === 'secret' && typeof candidate.key === 'string') {
      return formatConfigRef({ kind: 'secret', key: candidate.key });
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactConfigRefs(entry),
      ]),
    );
  }
  return value;
}
