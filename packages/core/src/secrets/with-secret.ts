/**
 * Runs a callback with a secret string and best-effort buffer zeroing.
 *
 * Note: JavaScript strings may be interned by V8, so this cannot guarantee
 * full memory erasure. It only zeroes the explicit Buffer allocated here.
 *
 * @param value Secret value.
 * @param fn Callback that consumes the secret.
 * @returns Callback return value.
 */
export async function withSecret<T>(value: string, fn: (v: string) => T | Promise<T>): Promise<T> {
  const buffer = Buffer.from(value, 'utf8');

  try {
    return await fn(buffer.toString('utf8'));
  } finally {
    buffer.fill(0);
  }
}
