import { z } from 'zod';

/**
 * Closed list of every check ID `yantra doctor` can emit (FEAT-071 TASK-006).
 */
export const DOCTOR_CHECK_IDS = [
  'browser.selection',
  'browser.compatibility',
  'browser.managed',
  'datadir.writable',
  'datadir.permissions',
  'cachedir.writable',
  'keychain.reachable',
  'indexdb.writable',
  'agent.model',
  'agent.credentials',
  'agent.budgets',
  'config.valid',
  'paths.resolved',
  'ethics.robots',
  'search.tavily.api-key',
  'search.brave.api-key',
  'search.provider',
] as const;

/** Closed enum of known `yantra doctor` check identifiers. */
export const DoctorCheckId = z
  .enum(DOCTOR_CHECK_IDS)
  .describe('Closed identifier of a known `yantra doctor` check.');
export type DoctorCheckId = z.infer<typeof DoctorCheckId>;

/** Status of a single doctor check or overall doctor outcome. */
export const DoctorStatus = z
  .enum(['ok', 'warn', 'fail'])
  .describe('Check status in CLI words: ok, warn, or fail.');
export type DoctorStatus = z.infer<typeof DoctorStatus>;

/** One diagnostic check row in a doctor result. */
export const DoctorCheck = z
  .object({
    id: z
      .string()
      .min(1)
      .describe(
        'Check identifier (a `DoctorCheckId`, or an unknown ID for forward compatibility).',
      ),
    title: z.string().min(1).describe('Human-readable check title.'),
    status: DoctorStatus,
    summary: z.string().describe('One-line outcome summary for this check.'),
    remediation: z.string().optional().describe('Prose fix hint when the check warns or fails.'),
    details: z
      .record(z.unknown())
      .optional()
      .describe('Optional structured key/value details for this check.'),
  })
  .strict()
  .describe('One diagnostic check emitted by `yantra doctor`.');
export type DoctorCheck = z.infer<typeof DoctorCheck>;

/** Browser selection and managed-storage provenance promoted out of browser checks. */
export const DoctorBrowserProvenance = z
  .object({
    source: z.string().describe('Configured browser source (e.g. auto, managed, or a path).'),
    origin: z.enum(['invocation', 'config', 'default']).describe('Where the selection came from.'),
    ownership: z
      .enum(['managed', 'external'])
      .optional()
      .describe('Whether Yantra manages the build.'),
    executablePath: z.string().optional().describe('Resolved canonical browser executable path.'),
    browserVersion: z.string().optional().describe('Detected browser version string.'),
    compatibility: z
      .enum(['tested', 'capability-checked', 'unverified', 'stale', 'failed'])
      .describe('Compatibility state of the selected browser.'),
    managedRoot: z.string().describe('Root directory for Yantra-managed browser builds.'),
    managedBuild: z.string().nullable().describe('Active managed build ID, or null when absent.'),
    orphanCount: z.number().int().nonnegative().describe('Count of superseded managed builds.'),
    reclaimableBytes: z
      .number()
      .int()
      .nonnegative()
      .describe('Bytes reclaimable by removing superseded managed builds.'),
    alternatives: z.array(z.string()).describe('Alternative browser executables discovered.'),
    remediation: z.string().optional().describe('Prose remediation for the browser selection.'),
  })
  .strict()
  .describe('Effective browser selection and managed-storage provenance.');
export type DoctorBrowserProvenance = z.infer<typeof DoctorBrowserProvenance>;

/** Search-provider provenance promoted out of `search.provider`. */
export const DoctorSearchProvenance = z
  .object({
    provider: z.string().min(1).describe('Planned search provider name.'),
    kind: z.enum(['api', 'scrape']).describe('Whether the provider uses a keyed API or scraping.'),
    via: z.enum(['flag', 'env', 'config', 'auto']).describe('Layer that selected the provider.'),
  })
  .strict()
  .describe('Planned search-provider provenance.');
export type DoctorSearchProvenance = z.infer<typeof DoctorSearchProvenance>;

/** Zod mirror of `DoctorRenderResult` (`apps/cli/src/render/types.ts`). */
export const DoctorResult = z
  .object({
    checks: z.array(DoctorCheck).describe('Ordered list of diagnostic checks.'),
    overall: DoctorStatus.describe('Worst status across all checks.'),
    version: z.string().min(1).describe('Yantra protocol version.'),
    platform: z.string().min(1).describe('Host operating system platform.'),
    nodeVersion: z.string().min(1).describe('Node.js runtime version.'),
    browser: DoctorBrowserProvenance.optional(),
    search: DoctorSearchProvenance.optional(),
  })
  .strict()
  .describe('Structured `yantra doctor` result.');
export type DoctorResult = z.infer<typeof DoctorResult>;

/** Params for `read.doctor`. */
export const DoctorReadParams = z
  .object({
    refresh: z
      .boolean()
      .optional()
      .describe('When true, bypasses the cached core environment probe.'),
  })
  .strict()
  .describe('Parameters for the in-process `read.doctor` RPC.');
export type DoctorReadParams = z.infer<typeof DoctorReadParams>;
