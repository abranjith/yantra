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

/** Result of `read.host_status` (FEAT-071 TASK-009). */
export const HostEnvironmentInfo = z
  .object({
    host_started_at: z
      .string()
      .datetime({ offset: true })
      .describe('ISO timestamp when the app host started.'),
    env_captured_at: z
      .string()
      .datetime({ offset: true })
      .describe('ISO timestamp when the host captured its environment (D13).'),
    yantra_version: z
      .string()
      .min(1)
      .describe('Version of the Yantra executable running the host.'),
    host_pid: z.number().int().positive().describe('Process ID of the running app host.'),
  })
  .strict()
  .describe('App host environment capture metadata; never includes environment names or values.');
export type HostEnvironmentInfo = z.infer<typeof HostEnvironmentInfo>;

/** One read-only retained ownership record whose identity verdict is `unknown` (FEAT-071 TASK-009). */
export const PossibleOrphan = z
  .object({
    run_id: z.string().min(1).describe('Run identifier owning the retained record.'),
    pid: z.number().int().positive().describe('Recorded process ID.'),
    recorded_start_token_present: z
      .boolean()
      .describe('Whether a creation start token was recorded on disk.'),
    executable: z
      .string()
      .min(1)
      .describe('Executable basename only; never a full directory path.'),
    recorded_at: z
      .string()
      .datetime({ offset: true })
      .describe('ISO timestamp when the ownership record was written.'),
    reason: z.literal('identity_unverifiable').describe('Why Yantra left the process untouched.'),
  })
  .strict()
  .describe('Read-only retained ownership record whose process identity is unverifiable.');
export type PossibleOrphan = z.infer<typeof PossibleOrphan>;

/** Result of `read.possible_orphans` (FEAT-071 TASK-009). */
export const PossibleOrphansResult = z
  .object({
    orphans: z
      .array(PossibleOrphan)
      .describe('Retained ownership records whose identity verdict is unknown.'),
  })
  .strict()
  .describe('Read-only list of possible orphan processes.');
export type PossibleOrphansResult = z.infer<typeof PossibleOrphansResult>;
