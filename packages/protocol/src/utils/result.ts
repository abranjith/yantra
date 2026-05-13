export type Result<TValue, TError> = { isOk: true; value: TValue } | { isOk: false; error: TError };

export const ok = <TValue>(value: TValue): Result<TValue, never> => ({
  isOk: true,
  value,
});

export const err = <TError>(error: TError): Result<never, TError> => ({
  isOk: false,
  error,
});
