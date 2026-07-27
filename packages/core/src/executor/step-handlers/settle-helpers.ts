/**
 * Page-settling wrappers for step handlers.
 *
 * A replayed step must wait for the page the same way the agent's own tools do,
 * or a promoted workflow reads its result before the result exists: `click`
 * used to return the instant `elementHandle.click()` resolved, so an `extract`
 * on the next step saw the pre-click document. On a real site — a carrier
 * tracking page whose result arrives via a fetch 10-30s later — that is the
 * difference between capturing the answer and capturing an empty shell.
 *
 * When no settler is present (a provider with no Puppeteer page, every test
 * fake) these degrade to running the action directly, so nothing that worked
 * before starts waiting or failing.
 */

import {
  CLICK_NAV_DETECT_MS,
  FILL_NAV_DETECT_MS,
  REDIRECT_CHAIN_DETECT_MS,
} from '../../browser/page-settle.js';
import type { ExecutionContext } from '../types.js';

export { CLICK_NAV_DETECT_MS, FILL_NAV_DETECT_MS };

/**
 * Runs a mutating action and holds until the page stops moving.
 *
 * The navigation watch is installed **before** `action` runs so a navigation
 * the site starts synchronously cannot slip through the gap.
 *
 * @param ctx - The run context carrying the optional settler.
 * @param graceMs - How long to keep watching for a late navigation; use
 *   {@link CLICK_NAV_DETECT_MS} for clicks, {@link FILL_NAV_DETECT_MS} for fills.
 * @param action - The action to perform.
 * @returns Whatever `action` returned, after the page has settled.
 */
export async function withPageSettling<T>(
  ctx: ExecutionContext,
  graceMs: number,
  action: () => Promise<T>,
): Promise<T> {
  const settler = ctx.settler;
  if (!settler) return action();
  const watch = settler.watch();
  try {
    const result = await action();
    await settler.settleAfterAction(watch, graceMs);
    return result;
  } finally {
    watch.dispose();
  }
}

/**
 * Holds a completed navigation until any follow-on redirect has committed and
 * the page has gone quiet.
 *
 * `page.goto()` resolves at the requested lifecycle event, which real sites
 * routinely bounce past: a meta-refresh, a client-side router, or a login
 * bounce lands a second document a moment later. Returning before that settles
 * hands the next step a document about to be replaced, and its locators
 * resolve against nothing.
 *
 * @param ctx - The run context carrying the optional settler.
 */
export async function settleAfterNavigation(ctx: ExecutionContext): Promise<void> {
  const settler = ctx.settler;
  if (!settler) return;
  const watch = settler.watch();
  try {
    await settler.settleAfterAction(watch, REDIRECT_CHAIN_DETECT_MS);
  } finally {
    watch.dispose();
  }
}

/**
 * Holds a read (extract/assert) until the document has finished loading and
 * its fetch-driven content has landed.
 *
 * Unlike {@link withPageSettling} this needs no watch: it asks the document its
 * current `readyState`, which reports a load already in flight — the case a
 * freshly installed request watch cannot see.
 *
 * @param ctx - The run context carrying the optional settler.
 */
export async function settleBeforeRead(ctx: ExecutionContext): Promise<void> {
  await ctx.settler?.settleBeforeRead();
}
