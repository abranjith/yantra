export const TRUNCATION_MARKER = '\n[...truncated by yantra sanitizer]';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Truncates text to an approximate UTF-8 byte budget without splitting codepoints.
 *
 * @param text Input text.
 * @param byteBudget UTF-8 byte budget before the marker is appended.
 * @returns Truncated output and truncation flag.
 */
export function truncateUtf8(
  text: string,
  byteBudget: number,
): { text: string; truncated: boolean } {
  const normalizedBudget = Number.isFinite(byteBudget) ? Math.max(0, Math.floor(byteBudget)) : 0;
  const bytes = Buffer.from(text, 'utf8');

  if (bytes.length <= normalizedBudget) {
    return { text, truncated: false };
  }

  const boundary = findSafeBoundary(bytes, normalizedBudget);
  const prefix = bytes.subarray(0, boundary).toString('utf8');

  return {
    text: `${prefix}${TRUNCATION_MARKER}`,
    truncated: true,
  };
}

function findSafeBoundary(buffer: Buffer, budget: number): number {
  let end = Math.min(Math.max(0, budget), buffer.length);

  while (end > 0) {
    if (isValidUtf8Prefix(buffer.subarray(0, end))) {
      return end;
    }
    end -= 1;
  }

  return 0;
}

function isValidUtf8Prefix(prefix: Buffer): boolean {
  try {
    UTF8_DECODER.decode(prefix);
    return true;
  } catch {
    return false;
  }
}
