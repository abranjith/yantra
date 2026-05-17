import { ok, err, type Result } from '@yantra/protocol';
import jsonata from 'jsonata';

export interface EvalScope {
  param?: Record<string, unknown>;
  capture?: Record<string, unknown>;
  previous_step?: unknown;
}

export class JSONataEvaluationError extends Error {
  override readonly name = 'JSONataEvaluationError';

  constructor(
    public readonly code: 'TIMEOUT' | 'SIZE_LIMIT' | 'INVALID_EXPRESSION' | 'OUT_OF_SCOPE',
    public readonly expression: string,
    message: string,
  ) {
    super(message);
  }
}

export interface JSONataEvaluatorOptions {
  timeoutMs?: number;
  maxResultBytes?: number;
}

export class JSONataEvaluator {
  private readonly timeoutMs: number;
  private readonly maxResultBytes: number;

  constructor(opts: JSONataEvaluatorOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 200;
    this.maxResultBytes = opts.maxResultBytes ?? 102400;
  }

  validate(expr: string): Result<void, JSONataEvaluationError> {
    try {
      jsonata(expr);
      return ok(undefined);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(new JSONataEvaluationError('INVALID_EXPRESSION', expr, message));
    }
  }

  async evaluate(expr: string, scope: EvalScope): Promise<Result<unknown, JSONataEvaluationError>> {
    const validationResult = this.validate(expr);
    if (!validationResult.isOk) {
      return validationResult;
    }

    let compiled: ReturnType<typeof jsonata>;
    try {
      compiled = jsonata(expr);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(new JSONataEvaluationError('INVALID_EXPRESSION', expr, message));
    }

    const scopeData: Record<string, unknown> = {};
    if (scope.param) scopeData.param = scope.param;
    if (scope.capture) scopeData.capture = scope.capture;
    if (scope.previous_step !== undefined) scopeData.previous_step = scope.previous_step;

    const timeoutMs = this.timeoutMs;

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new JSONataEvaluationError(
              'TIMEOUT',
              expr,
              `JSONata expression timed out after ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      ),
    );

    const evalPromise = compiled.evaluate(scopeData);

    let result: unknown;
    try {
      result = await Promise.race([evalPromise, timeoutPromise]);
    } catch (e) {
      if (e instanceof JSONataEvaluationError) {
        return err(e);
      }
      const message = e instanceof Error ? e.message : String(e);
      return err(new JSONataEvaluationError('INVALID_EXPRESSION', expr, message));
    }

    const serialized = JSON.stringify(result);
    const byteSize = new TextEncoder().encode(serialized).length;
    if (byteSize > this.maxResultBytes) {
      return err(
        new JSONataEvaluationError(
          'SIZE_LIMIT',
          expr,
          `JSONata result size ${byteSize} bytes exceeds limit of ${this.maxResultBytes} bytes`,
        ),
      );
    }

    return ok(result);
  }
}
