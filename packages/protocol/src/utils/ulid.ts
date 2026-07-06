/**
 * ULID helpers shared by protocol document schemas and builders.
 *
 * A ULID is a 26-character, lexicographically sortable identifier encoded
 * with the Crockford base32 alphabet (no I, L, O, U). Yantra uses ULIDs for
 * every protocol document id (`task_id`, `plan_id`, `brief_id`).
 */

/** Crockford base32 encoding alphabet. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Validation pattern for a 26-character Crockford base32 ULID. */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Generates a 26-character ULID.
 *
 * Format: 10 timestamp characters (48-bit ms since epoch) followed by
 * 16 random characters (80 bits from the Web Crypto CSPRNG), all in the
 * Crockford base32 alphabet. Output always matches {@link ULID_PATTERN}.
 *
 * @returns A newly generated ULID string.
 *
 * @example
 * const briefId = generateUlid(); // '01J5XKQ8ZR3V9M2T7CWB4NDYFA'
 */
export const generateUlid = (): string => {
  // 48-bit timestamp (ms since epoch)
  let ts = Date.now();
  const tsChars: string[] = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    tsChars[i] = CROCKFORD[ts & 0x1f]!;
    ts = Math.floor(ts / 32);
  }

  // 80-bit random
  const randBytes = new Uint8Array(10);
  crypto.getRandomValues(randBytes);
  const randChars: string[] = new Array<string>(16);
  let bitBuf = 0;
  let bitsLeft = 0;
  let byteIdx = 0;
  for (let i = 0; i < 16; i++) {
    while (bitsLeft < 5) {
      bitBuf = (bitBuf << 8) | randBytes[byteIdx++]!;
      bitsLeft += 8;
    }
    bitsLeft -= 5;
    randChars[i] = CROCKFORD[(bitBuf >> bitsLeft) & 0x1f]!;
  }

  return tsChars.join('') + randChars.join('');
};
