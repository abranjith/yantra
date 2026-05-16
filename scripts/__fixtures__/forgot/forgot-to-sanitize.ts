class LLMClient {
  static send(payload: string): string {
    return payload;
  }
}

export function forgotToSanitize(): string {
  const raw = 'sensitive payload';
  return LLMClient.send(raw);
}
