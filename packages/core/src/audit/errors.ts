export class AuditLogWriteError extends Error {
  override readonly name = 'AuditLogWriteError';

  public constructor(
    message: string,
    public readonly context: {
      readonly runId: string;
      readonly file: string;
      readonly cause?: unknown;
    },
  ) {
    super(message);
  }
}
