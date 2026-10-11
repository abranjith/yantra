import { z } from 'zod';

/**
 * `run-health.json` (FEAT-048): an agentic run's own account of what happened
 * to it — searches by outcome and failure code, network fetches by mode, per-
 * source failures by stage, browser launches, budget consumption, tool
 * failures, and the runtime-derived notices it attached to its document.
 *
 * Every field is a count, a closed code, a budget name, or a provider name.
 * No message, URL, or page text ever appears here. The artifact is optional
 * for every reader: runs written before it existed have no file.
 */

const Count = z.number().int().nonnegative();

/** Counts keyed by a stable error code (`SEARCH_BLOCKED`, `FETCH_TIMEOUT`, …). */
const CountsByCode = z
  .record(z.string().min(1), Count)
  .describe('Counts keyed by stable error code.');

export const RUN_HEALTH_SCHEMA_VERSION = 1 as const;

export const RunHealth = z
  .object({
    schema_version: z.literal(RUN_HEALTH_SCHEMA_VERSION).describe('Run-health schema version.'),
    run_id: z.string().min(1).describe('Owning run id.'),
    searches: z
      .object({
        total: Count.describe('Searches attempted (ok + failed).'),
        ok: Count.describe('Searches that returned results.'),
        failed_by_code: CountsByCode.describe('Failed searches by stable failure code.'),
        providers: z
          .array(z.string().min(1))
          .describe('Distinct search providers used, in first-use order.'),
      })
      .describe('Web searches by outcome.'),
    fetches: z
      .object({
        total: Count.describe('Real network page fetches.'),
        by_mode: z
          .object({
            http: Count.describe('Pages served by the HTTP tier.'),
            browser: Count.describe('Pages served by a browser render.'),
          })
          .describe('Network fetches by how they were served.'),
        repeat_fetches: Count.describe(
          'Network fetches of a normalized URL already fetched earlier in the run.',
        ),
        failed_by_code: CountsByCode.describe('Failed `web_fetch` calls by stable error code.'),
      })
      .describe('Network page fetches.'),
    source_failures: z
      .object({
        fetch: Count.describe('Per-site fetch failures.'),
        extract: Count.describe('Per-site pages fetched but not readable.'),
        blocked: Count.describe('Per-site ethics refusals (robots, blocklist, rate limit).'),
        budget: Count.describe(
          "Page reads skipped by the run's own navigation/host budget (web_search sites and web_fetch calls).",
        ),
        policy: Count.describe("Per-site reads refused by the run's own URL policy."),
      })
      .describe('Per-site read failures inside multi-source tools, by stage.'),
    browser: z
      .object({ launches: Count.describe('Successful browser process launches.') })
      .describe('Browser processes.'),
    budgets: z
      .object({
        navigations_used: Count.describe('Navigations consumed.'),
        navigations_limit: Count.describe('Configured navigation ceiling.'),
        hosts_used: Count.describe('Distinct hosts consumed.'),
        hosts_limit: Count.describe('Configured distinct-host ceiling.'),
        exhausted: z
          .array(z.string().min(1))
          .describe('Budget limits that refused at least one call, in first-hit order.'),
      })
      .describe('Run budget consumption.'),
    tool_failures: z
      .object({
        total: Count.describe('Tool calls that ended in error or timeout.'),
        by_code: CountsByCode.describe('Failed tool calls by stable error code.'),
      })
      .describe('Tool failures across every tool.'),
    notices: Count.describe(
      'Runtime-derived notices attached to the published document; 0 when nothing was published.',
    ),
  })
  .superRefine((health, ctx) => {
    const failed = Object.values(health.searches.failed_by_code).reduce((sum, n) => sum + n, 0);
    if (health.searches.total !== health.searches.ok + failed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['searches', 'total'],
        message: `searches.total (${health.searches.total}) must equal ok + failed (${health.searches.ok + failed}).`,
      });
    }
    const byMode = health.fetches.by_mode.http + health.fetches.by_mode.browser;
    if (health.fetches.total !== byMode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fetches', 'total'],
        message: `fetches.total (${health.fetches.total}) must equal the by_mode sum (${byMode}).`,
      });
    }
  })
  .describe(
    "An agentic run's own health summary (run-health.json): searches, fetches, source failures, browser launches, budgets, tool failures, and runtime notices. Counts and closed codes only.",
  );

export type RunHealth = z.infer<typeof RunHealth>;
