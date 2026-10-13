/** The single grammar for model-visible evidence references and inline markers. */
export const INLINE_EVIDENCE_REF = /\[(S[1-9]\d*(?:#r[1-9]\d*)?)\]/gu;
const EVIDENCE_REF = /^(S[1-9]\d*)(?:#r([1-9]\d*))?$/u;

/** Parse an exact run source ID or record anchor; malformed IDs return null. */
export function parseEvidenceRef(raw: string): { sourceId: string; anchor: number | null } | null {
  const match = EVIDENCE_REF.exec(raw);
  if (match?.[1] === undefined) return null;
  const anchor = match[2] === undefined ? null : Number(match[2]);
  if (anchor !== null && !Number.isSafeInteger(anchor)) return null;
  return { sourceId: match[1], anchor };
}
