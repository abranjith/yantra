import { DanglingInteractionMessageError, type MessageTemplate } from '@yantra/core';

/** Agent-owned tool and middleware messages in the interaction inventory. */
export const AGENT_INTERACTION_MESSAGES = [
  tool(
    'BROWSER_UNAVAILABLE',
    'not-configured',
    () => 'Browser services are not configured for this run.',
  ),
  tool('BROWSER_UNAVAILABLE', 'services-missing', () => 'Browser services are not configured.'),
  tool('BROWSER_NOT_STARTED', 'not-started', passThrough, ['message']),
  // Browser startup refusals. Each one is a condition on the user's machine
  // that this run cannot repair, so every message ends the same way: tell the
  // user what to do, then publish. They name `result_publish` — the one move
  // the agent actually has — and never a browser-management command it cannot
  // invoke. The prose is authored here rather than passed through from the core
  // error, whose message may carry an executable path or raw helper output.
  tool(
    'BROWSER_RESOLUTION_FAILED',
    'resolution',
    () =>
      'No usable browser is available on this machine, so browser-backed steps cannot run. ' +
      'Do not retry: nothing in this run can install or repair one. Tell the user that Yantra ' +
      'found no usable Chrome or Chromium and that they can install one, or run ' +
      '`yantra browser install` themselves, then finish with result_publish using whatever ' +
      'evidence you already have.',
    [],
    'result_publish',
  ),
  tool(
    'BROWSER_COMPATIBILITY_FAILED',
    'capability',
    () =>
      'The browser on this machine is missing an automation primitive Yantra requires, so it ' +
      'was refused before any page opened. Do not retry: the same browser will fail the same ' +
      'check. Tell the user their browser failed the local compatibility check and that ' +
      '`yantra browser check` names the failing primitive, then finish with result_publish.',
    [],
    'result_publish',
  ),
  tool(
    'BROWSER_COORDINATION_FAILED',
    'coordination',
    () =>
      'The Yantra-managed browser is busy with another operation, so this run could not claim ' +
      'it. Do not retry: the claim is held outside this run. Tell the user another Yantra ' +
      'browser operation is in progress and to try again once it finishes, then finish with ' +
      'result_publish.',
    [],
    'result_publish',
  ),
  tool(
    'BROWSER_LAUNCH_FAILED',
    'launch',
    () =>
      'The browser could not be started on this machine. Do not retry: the failure is in the ' +
      'local environment, not in how this call was formed. Tell the user the browser failed to ' +
      'launch and that `yantra doctor` reports the local browser state, then finish with ' +
      'result_publish.',
    [],
    'result_publish',
  ),
  tool(
    'BROWSER_PROCESS_FAILED',
    'process',
    () =>
      'The browser process could not be accounted for, so this run will not use it. Do not ' +
      'retry. Tell the user the browser process did not start or exit cleanly and that a ' +
      'leftover browser process may need to be closed, then finish with result_publish.',
    [],
    'result_publish',
  ),
  tool(
    'BROWSER_INSTALL_DECLINED',
    'declined',
    () =>
      'The user declined the offer to download a Yantra-managed browser, so browser-backed ' +
      'steps are unavailable. This is their decision, not an error — do not ask again and do ' +
      'not retry. Tell the user they can run `yantra browser install` whenever they are ready, ' +
      'then finish with result_publish using whatever evidence you already have.',
    [],
    'result_publish',
  ),
  tool(
    'BROWSER_INSTALL_FAILED',
    'managed-install',
    () =>
      'Installing the Yantra-managed browser failed, so no browser is available for this run. ' +
      'Do not retry: this run cannot re-attempt the download. Tell the user the managed browser ' +
      'install did not complete and that `yantra browser install` reports the specific cause, ' +
      'then finish with result_publish.',
    [],
    'result_publish',
  ),
  // `web_search` provider failures (FEAT-048). One template per cause, each
  // saying what happened (naming the provider), whether a retry can help, and
  // one engineered next step. Setup commands appear only as advice to relay to
  // the user — the agent has no tool that configures a provider.
  tool(
    'SEARCH_BLOCKED',
    'anomaly-challenge',
    (details) =>
      `${text(details.provider)} served an anti-bot challenge instead of search results. Do not ` +
      'search again in this run: repeating the query meets the same challenge. Use web_fetch on a ' +
      'URL an earlier result already returned, or finish with result_publish and say in the ' +
      'overview that web search was blocked.',
    ['provider'],
    'web_fetch',
  ),
  tool(
    'SEARCH_BLOCKED',
    'rate-limited',
    (details) =>
      `${text(details.provider)} rejected the search because its rate limit was reached. Do not ` +
      'retry: further searches in this run will be throttled the same way. Use web_fetch on a URL ' +
      'an earlier result already returned, or finish with result_publish and say that search was ' +
      'rate-limited.',
    ['provider'],
    'web_fetch',
  ),
  tool(
    'SEARCH_NO_RESULTS',
    'empty-results',
    (details) =>
      `${text(details.provider)} returned no results for this query; the search itself worked. ` +
      'Reformulate the query once with broader or different keywords and search again. If that ' +
      'also returns nothing, finish with result_publish and state that no results were found.',
    ['provider'],
    'web_search',
  ),
  tool(
    'SEARCH_TIMEOUT',
    'timeout',
    (details) =>
      `The search through ${text(details.provider)} timed out before results arrived. One retry ` +
      'of the same query may succeed. If it times out again, stop searching and finish with ' +
      'result_publish using the evidence you already have.',
    ['provider'],
    'web_search',
  ),
  tool(
    'SEARCH_PROVIDER_UNAVAILABLE',
    'ethics-refused',
    (details) =>
      `Yantra's ethics policy refused the ${text(details.provider)} search page ` +
      `(${text(details.reason)}), so searching through it is not permitted in this run. Do not ` +
      'retry. Use web_fetch on a URL you already have, or finish with result_publish and say that ' +
      'web search was unavailable.',
    ['provider', 'reason'],
    'web_fetch',
  ),
  tool(
    'SEARCH_PROVIDER_UNAVAILABLE',
    'key-missing',
    (details) =>
      `${text(details.provider)} needs an API key that is not configured, so web search is ` +
      'unavailable for this run. Do not retry: nothing in this run can add a key. Tell the user ' +
      'to store the key with `yantra init`, or to choose a key-free provider with ' +
      '`--search-provider duckduckgo`, then finish with result_publish.',
    ['provider'],
    'result_publish',
  ),
  tool(
    'SEARCH_PROVIDER_UNAVAILABLE',
    'no-provider-available',
    () =>
      'No search provider is usable: every configured provider needs an API key that is missing. ' +
      'Do not retry. Tell the user to configure a keyed provider with `yantra init`, or to add a ' +
      'key-free provider to the search fallback chain, then finish with result_publish.',
    [],
    'result_publish',
  ),
  tool(
    'SEARCH_PROVIDER_UNAVAILABLE',
    'unknown-provider',
    () =>
      'The configured search provider is not one Yantra recognizes, so web search is ' +
      'unavailable. Do not retry. Tell the user to correct the provider setting ' +
      '(`--search-provider` or `search.provider`), then finish with result_publish.',
    [],
    'result_publish',
  ),
  tool(
    'SEARCH_PROVIDER_UNAVAILABLE',
    'auth-rejected',
    (details) =>
      `${text(details.provider)} rejected the configured API key, so web search is unavailable ` +
      'for this run. Do not retry with the same key. Tell the user to check or replace the key ' +
      'with `yantra init`, then finish with result_publish.',
    ['provider'],
    'result_publish',
  ),
  tool(
    'SEARCH_PROVIDER_UNAVAILABLE',
    'http-5xx',
    (details) =>
      `${text(details.provider)} returned a server error. The fault is on the provider's side and ` +
      'may clear: retry the search once. If it fails again, finish with result_publish using the ' +
      'evidence you already have.',
    ['provider'],
    'web_search',
  ),
  tool(
    'SEARCH_FAILED',
    'http-4xx',
    (details) =>
      `${text(details.provider)} refused the search request. Retrying the same request will fail ` +
      'the same way. Use web_fetch on a URL you already have, or finish with result_publish.',
    ['provider'],
    'web_fetch',
  ),
  tool(
    'SEARCH_FAILED',
    'invalid-response',
    (details) =>
      `${text(details.provider)} answered with a response Yantra could not read, so this search ` +
      'produced no results. Do not repeat the same query. Use web_fetch on a URL you already ' +
      'have, or finish with result_publish.',
    ['provider'],
    'web_fetch',
  ),
  tool(
    'SEARCH_FAILED',
    'serp-fetch-failed',
    (details) =>
      `Loading the ${text(details.provider)} results page failed before any results could be ` +
      'read. This can be transient: retry the search once. If it fails again, finish with ' +
      'result_publish using the evidence you already have.',
    ['provider'],
    'web_search',
  ),
  tool(
    'SEARCH_FAILED',
    'aborted',
    (details) =>
      `The search through ${text(details.provider)} was cancelled before it completed. Do not ` +
      'retry; finish with result_publish using the evidence you already have.',
    ['provider'],
    'result_publish',
  ),
  tool(
    'SEARCH_FAILED',
    'unexpected',
    (details) =>
      `The search through ${text(details.provider)} failed for a reason Yantra could not ` +
      'classify. Do not repeat the same query. Use web_fetch on a URL you already have, or ' +
      'finish with result_publish.',
    ['provider'],
    'web_fetch',
  ),
  // A scraped provider that challenged once is not asked again in this run
  // (FEAT-050 breaker). The first challenge is reported under its own cause
  // above; every later search is refused here with no provider call at all.
  tool(
    'SEARCH_BLOCKED',
    'circuit-open',
    (details) =>
      `Web search is closed for the rest of this run: ${text(details.provider)} challenged an ` +
      'earlier query, so Yantra stopped asking it. This search was not attempted. Use web_fetch ' +
      'on a URL an earlier result already returned, or finish with result_publish and say that ' +
      'web search was blocked.',
    ['provider'],
    'web_fetch',
  ),
  // Run document store (FEAT-050): a page is read once per run, under one
  // evidence ID, and a read that cannot change is not attempted twice.
  tool(
    'WEB_READ',
    'already-read',
    (details) =>
      `This page was already read earlier in this run; its content was returned then as ` +
      `${text(details.source_id)} and was not fetched again. Use that earlier result, read a ` +
      'different URL, or finish with result_publish.',
    ['source_id'],
    'result_publish',
  ),
  tool(
    'WEB_READ',
    'already-attempted',
    (details) =>
      `This URL was already attempted earlier in this run and failed (${text(details.code)}). ` +
      'That failure cannot change within the run, so it was not fetched again. Do not request ' +
      'it again: read a different URL from an earlier result, or finish with result_publish.',
    ['code'],
    'result_publish',
  ),
  tool(
    'WEB_SEARCH',
    'discovery',
    () =>
      'Discovery results: titles, URLs, and snippets only — no page was fetched and no ' +
      'navigation was spent. Snippets are not page content. To read one, call web_fetch with ' +
      'its URL exactly as listed.',
    [],
    'web_fetch',
  ),
  // A human-verification page (FEAT-050 G10, policy b). The run never solves,
  // waits out, or retries a challenge, so the only moves are other evidence
  // or publishing; the handoff detail makes an unpublished run a handoff.
  tool(
    'SITE_CHALLENGE',
    'challenge',
    (details) =>
      `${text(details.host)} served a human-verification page instead of content. Yantra cannot ` +
      'and will not pass it, and will not request this page again in this run. Use evidence ' +
      'from your other reads, or finish with result_publish and say that this page was blocked.',
    ['host'],
    'result_publish',
  ),
  // The run's own navigation/host budget ran out inside one `web_search`
  // (FEAT-048 G6). Reported once at the top of the result, never per site,
  // and worded so it can never be read as the sites refusing the run.
  tool(
    'BUDGET_EXHAUSTED',
    'search-reads-skipped',
    (details) =>
      `Yantra's own ${details.limit === 'hosts' ? 'distinct-host' : 'navigation'} budget for ` +
      `this run is spent, so ${text(details.skipped)} further search result(s) were not read. ` +
      'This is the run limit, not the sites refusing you, and searching again cannot read more ' +
      'pages. Finish with result_publish now; the evidence already gathered is attached ' +
      'automatically.',
    ['limit', 'skipped'],
    'result_publish',
  ),
  tool(
    'URL_NOT_FROM_EVIDENCE',
    'unattested-url',
    (details) =>
      'This URL introduces a path or parameter name that no search result or visited page attested. You may vary query values on an already-visited URL, but may not invent a new path, parameter name, or identifier. Use web_search or click through from an observed page to attest anything else.' +
      (details.repeated === true
        ? " This same normalized URL has already been refused. Submit the page's form with browser_click on its submit/search control, or reach the target by clicking a search result. Repeating this URL will keep failing."
        : ''),
    ['repeated'],
    'web_search',
  ),
  tool(
    'ETHICS_BLOCKED',
    'navigation-refused',
    (details) => `Navigation refused for ${text(details.host)}: ${text(details.reason)}.`,
    ['host', 'reason'],
  ),
  tool(
    'SECRET_RESOLVER_UNAVAILABLE',
    'resolver-missing',
    () => 'Website secret resolution is unavailable.',
  ),
  tool(
    'SENSITIVE_SCREEN_LATCH_UNAVAILABLE',
    'guard-missing',
    () => 'Secret fill was denied because the sensitive-screen guard is unavailable.',
  ),
  tool(
    'SCREENSHOT_SENSITIVE_SCREEN',
    'secret-latched',
    () =>
      'Screenshot capture was denied because a resolved secret may still be visible. Capture resumes only after the top-level page navigates to a new document.',
  ),
  tool('SCREENSHOT_UNAVAILABLE', 'capture-failed', passThrough, ['message']),
  tool('SECRET_HOST_MISMATCH', 'host-binding', passThrough, ['message']),
  tool(
    'EXTRACTION_SCHEMA_INVALID',
    'invalid-extraction',
    (details) => `The page did not produce a valid ${text(details.kind)} extraction.`,
    ['kind'],
  ),
  tool(
    'INVALID_INPUT',
    'extraction-kind',
    (details) =>
      `"${text(details.kind).slice(0, 40)}" is not a supported extraction kind. Retry with kind:"content" for the page title and readable text, or kind:"table" for the first table.`,
    ['kind'],
  ),
  middleware('INVALID_INPUT', 'schema-validation', passThrough, ['message']),
  middleware(
    'TOOL_TIMEOUT',
    'execution-timeout',
    (details) =>
      `Tool "${text(details.tool)}" exceeded its ${text(details.timeoutMs)}ms execution budget.`,
    ['tool', 'timeoutMs'],
  ),
  middleware('AGENT_ABORTED', 'run-aborted', () => 'The run was aborted.'),
  middleware(
    'CONFIRMATION_UNAVAILABLE',
    'gateway-missing',
    () => 'This action requires confirmation, but no consent surface is available.',
  ),
  middleware(
    'CONFIRMATION_TIMEOUT',
    'non-interactive',
    () => 'Confirmation could not be obtained (non-interactive run); the action was not taken.',
  ),
  middleware(
    'CONFIRMATION_TIMEOUT',
    'timed-out',
    () => 'Confirmation timed out; the action was not taken.',
  ),
  middleware(
    'CONFIRMATION_DENIED',
    'denied',
    () => 'Confirmation was denied; the action was not taken.',
  ),
  middleware('BUDGET_EXHAUSTED', 'budget-decision', passThrough, ['message'], 'result_publish'),
  middleware(
    'ACTION_PHASE_CLOSED',
    'published',
    () => 'The result has already been published; mutating tools are no longer available.',
  ),
  middleware(
    'EVIDENCE_FROZEN',
    'evidence-closed',
    () =>
      'Evidence gathering is closed for this run. Call result_publish now with your title and overview — the sources you already fetched are attached automatically.',
    [],
    'result_publish',
  ),
  middleware(
    'TOOL_EXECUTION_FAILED',
    'unexpected',
    (details) => `The "${text(details.tool)}" tool failed unexpectedly.`,
    ['tool'],
  ),
] as const satisfies readonly MessageTemplate[];

export function renderAgentMessage(
  surface: 'tool' | 'middleware',
  code: string,
  cause: string,
  details: Readonly<Record<string, unknown>> = {},
): string {
  const template = AGENT_INTERACTION_MESSAGES.find(
    (entry) => entry.surface === surface && entry.code === code && entry.cause === cause,
  );
  if (!template)
    throw new DanglingInteractionMessageError(`${surface}/${code}/${cause}`, ['template']);
  const missing = template.requiredDetails.filter(
    (key) => details[key] === undefined || details[key] === null,
  );
  if (missing.length > 0) {
    throw new DanglingInteractionMessageError(`${surface}/${code}/${cause}`, missing);
  }
  return template.message(details);
}

function tool(
  code: string,
  cause: string,
  message: MessageTemplate['message'],
  requiredDetails: readonly string[] = [],
  capability: string | null = null,
): MessageTemplate {
  return entry('tool', code, cause, message, requiredDetails, capability);
}

function middleware(
  code: string,
  cause: string,
  message: MessageTemplate['message'],
  requiredDetails: readonly string[] = [],
  capability: string | null = null,
): MessageTemplate {
  return entry('middleware', code, cause, message, requiredDetails, capability);
}

function entry(
  surface: 'tool' | 'middleware',
  code: string,
  cause: string,
  message: MessageTemplate['message'],
  requiredDetails: readonly string[],
  capability: string | null,
): MessageTemplate {
  return {
    surface,
    code,
    cause,
    message,
    hint: message,
    requiredDetails,
    capability,
    capabilityKind: capability === null ? null : 'tool',
  };
}

function passThrough(details: Readonly<Record<string, unknown>>): string {
  return text(details.message);
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}
