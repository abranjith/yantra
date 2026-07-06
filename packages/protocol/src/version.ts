import type { Plan } from './schemas/plan.js';
import { PlanSchema } from './schemas/plan.js';
import type { Result } from './utils/result.js';
import { err, ok } from './utils/result.js';

/**
 * Schema versioning policy:
 * - additive changes bump minor (0.2 added the Brief document type; Plan and
 *   workflow contracts are unchanged and 0.1 documents remain valid)
 * - breaking changes require a major bump and migration notes
 * - every version in SUPPORTED_SCHEMA_VERSIONS stays accepted by
 *   parseSchemaVersion until a major bump retires it
 */
export const SCHEMA_VERSION = '0.2' as const;

/** Every schema version currently accepted, oldest first. */
export const SUPPORTED_SCHEMA_VERSIONS = ['0.1', SCHEMA_VERSION] as const;

export type SchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];

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
 * parseSchemaVersion('0.2') // ok('0.2')
 * parseSchemaVersion('0.1') // ok('0.1') — legacy documents stay valid
 */
export const parseSchemaVersion = (value: unknown): Result<SchemaVersion, VersionError> => {
  if (
    typeof value === 'string' &&
    (SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(value)
  ) {
    return ok(value as SchemaVersion);
  }

  return err(
    new VersionError(
      value,
      `Unsupported schema_version: ${String(value)}. Expected one of ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}.`,
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
