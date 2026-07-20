/** Strict normalization for the domain-only ranking data boundary. */

import { err, ok, type Result } from '@yantra/protocol';

const DOMAIN_SHAPE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Validation failure for a domain supplied to ranking or `yantra sites`. */
export class DomainValidationError extends Error {
  public override readonly name = 'DomainValidationError';

  public constructor(message: string) {
    super(message);
  }
}

/**
 * Normalizes a hostname for local ranking storage.
 *
 * The function accepts hostname-shaped ASCII input only: schemes, paths,
 * credentials, ports, and bare top-level domains are rejected. One leading
 * `www.` is removed after trimming and lowercasing. It never throws.
 */
export function normalizeDomain(input: string): Result<string, DomainValidationError> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return err(new DomainValidationError('Domain is required (for example, example.com).'));
  }

  if ([...trimmed].some((char) => (char.codePointAt(0) ?? 0) > 0x7f)) {
    return err(
      new DomainValidationError(
        'Internationalized domains are not supported yet; enter the ASCII hostname.',
      ),
    );
  }

  if (/\s/.test(trimmed)) {
    return err(new DomainValidationError('Domain must not contain whitespace.'));
  }

  const normalized = trimmed.toLowerCase().replace(/^www\./, '');
  if (!DOMAIN_SHAPE.test(normalized)) {
    return err(
      new DomainValidationError(
        'Enter a hostname such as example.com without a scheme, path, port, or credentials.',
      ),
    );
  }

  return ok(normalized);
}
