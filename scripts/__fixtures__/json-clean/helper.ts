// Reachable from the clean `--json` entry. Serializes with no decoration deps.
export function formatPayload(value: string): string {
  return JSON.stringify({ value });
}
