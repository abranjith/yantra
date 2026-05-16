class LLMClient {
  static send(payload: string): string {
    return payload;
  }
}

function sanitize(value: string): string {
  return value.trim();
}

export function correctlySanitized(): string {
  const raw = 'sensitive payload';
  const safe = sanitize(raw);
  return LLMClient.send(safe);
}
