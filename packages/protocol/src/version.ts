import type { Plan } from './schemas/plan.js';
import { PlanSchema } from './schemas/plan.js';
import type { Result } from './utils/result.js';
import { err, ok } from './utils/result.js';

/**
 * Schema versioning policy:
 * - v0 uses a single literal value (0.1)
 * - additive changes bump minor (for example 0.2)
 * - breaking changes require a major bump and migration notes
 */
export const SCHEMA_VERSION = '0.1' as const;

export type SchemaVersion = typeof SCHEMA_VERSION;

export class VersionError extends Error {
  public readonly code = 'version_error';

  public constructor(
    public readonly received: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'VersionError';
  }
}

/**
 * @example
 * parseSchemaVersion('0.1')
 */
export const parseSchemaVersion = (value: unknown): Result<SchemaVersion, VersionError> => {
  if (value === SCHEMA_VERSION) {
    return ok(SCHEMA_VERSION);
  }

  return err(
    new VersionError(
      value,
      `Unsupported schema_version: ${String(value)}. Expected ${SCHEMA_VERSION}.`,
    ),
  );
};

export type PlanValidator = (rawPlan: unknown) => Result<Plan, VersionError | Error>;

export const selectValidator = (rawPlan: unknown): PlanValidator => {
  const version =
    typeof rawPlan === 'object' && rawPlan !== null
      ? (rawPlan as { schema_version?: unknown }).schema_version
      : undefined;

  const parsedVersion = parseSchemaVersion(version);
  if (!parsedVersion.isOk) {
    return () => err(parsedVersion.error);
  }

  return (candidate: unknown): Result<Plan, VersionError | Error> => {
    const parsed = PlanSchema.safeParse(candidate);
    if (!parsed.success) {
      return err(new Error(parsed.error.message));
    }

    return ok(parsed.data);
  };
};
