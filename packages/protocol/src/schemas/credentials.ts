import { z } from 'zod';

/**
 * Credentials RPC and read-model schemas (FEAT-071 TASK-002).
 *
 * Secret values are write-only: `SecretSetRequest.value` carries
 * `.describe('secret')` so host log redaction scrubs it, and no response
 * schema ever includes a secret value or its length.
 */

/** Matches `SECRET_REF` account grammar in `@yantra/core` (`${secret:<key>}`). */
export const CREDENTIAL_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

/** Maximum byte length of a stored secret value (8 KiB). */
export const CREDENTIAL_MAX_BYTES = 8192 as const;

/** Validates a credential key using the `${secret:<key>}` grammar. */
export function isValidCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY_PATTERN.test(key);
}

/** A display-safe configuration reference (never carries a value or length). */
export const ConfigRefDisplay = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('secret'),
        key: z.string().min(1).describe('Keychain account name.'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('env'),
        name: z.string().min(1).describe('Environment variable name.'),
      })
      .strict(),
  ])
  .describe('A configuration reference without any secret value.');
export type ConfigRefDisplay = z.infer<typeof ConfigRefDisplay>;

/** Where a credential is stored or resolved from. */
export const CredentialSource = z
  .enum(['keychain', 'env', 'absent'])
  .describe('Where the credential currently resolves from.');
export type CredentialSource = z.infer<typeof CredentialSource>;

/** A configuration entry that references a credential. */
export const CredentialReference = z
  .object({
    kind: z.enum(['model', 'search']),
    id: z.string().min(1),
    ref: ConfigRefDisplay,
  })
  .strict()
  .describe('A model or search configuration entry referencing this credential.');
export type CredentialReference = z.infer<typeof CredentialReference>;

/** One row in the credentials table. */
export const CredentialRow = z
  .object({
    key: z.string().min(1),
    source: CredentialSource,
    referenced_by: z.array(CredentialReference),
  })
  .strict()
  .describe('A credential entry with its source and configuration references.');
export type CredentialRow = z.infer<typeof CredentialRow>;

/** `secret.list` response. */
export const CredentialListResult = z
  .object({
    available: z.boolean(),
    remedy: z.string().nullable(),
    rows: z.array(CredentialRow),
  })
  .strict()
  .describe('Keychain availability and credential rows (names and references only).');
export type CredentialListResult = z.infer<typeof CredentialListResult>;

/** `secret.set` request. */
export const SecretSetRequest = z
  .object({
    key: z
      .string()
      .min(1, 'Credential key must not be empty.')
      .regex(
        CREDENTIAL_KEY_PATTERN,
        'Invalid credential key; expected a key such as tavily.api_key.',
      )
      .describe('Keychain account name.'),
    value: z
      .string()
      .min(1, 'Secret value must not be empty.')
      .refine(
        (value) => new TextEncoder().encode(value).length <= CREDENTIAL_MAX_BYTES,
        'Secret value must not exceed 8 KiB.',
      )
      .describe('secret'),
  })
  .strict()
  .describe('Store or replace a credential in the OS keychain.');
export type SecretSetRequest = z.infer<typeof SecretSetRequest>;

/** `secret.set` response (never echoes the value). */
export const SecretSetResponse = z
  .object({
    status: z.literal('set'),
    key: z.string().min(1),
  })
  .strict()
  .describe('Confirmation that the credential was stored.');
export type SecretSetResponse = z.infer<typeof SecretSetResponse>;

/** `secret.rm` request. */
export const SecretRemoveRequest = z
  .object({
    key: z
      .string()
      .min(1, 'Credential key must not be empty.')
      .regex(
        CREDENTIAL_KEY_PATTERN,
        'Invalid credential key; expected a key such as tavily.api_key.',
      )
      .describe('Keychain account name.'),
  })
  .strict()
  .describe('Remove a credential from the OS keychain.');
export type SecretRemoveRequest = z.infer<typeof SecretRemoveRequest>;

/** `secret.rm` response. */
export const SecretRemoveResponse = z
  .object({
    status: z.enum(['removed', 'absent']),
    key: z.string().min(1),
  })
  .strict()
  .describe('Whether the credential was removed or already absent.');
export type SecretRemoveResponse = z.infer<typeof SecretRemoveResponse>;
