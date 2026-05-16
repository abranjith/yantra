export class SanitizationProfileError extends Error {
  override readonly name = 'SanitizationProfileError';

  public constructor(
    message: string,
    public readonly context?: {
      readonly profile?: string;
      readonly filePath?: string;
      readonly cause?: unknown;
    },
  ) {
    super(message);
  }
}
