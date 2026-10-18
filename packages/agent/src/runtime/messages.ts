import { DanglingInteractionMessageError, type MessageTemplate } from '@yantra/core';

/**
 * The one "repeated refusal" sentence, shared by every provenance refusal so a
 * model alternating tools on one guessed URL reads the same warning.
 */
const REFUSED_AGAIN =
  ' This same normalized URL has already been refused in this run. Repeating this URL will keep failing.';

/** Agent-owned tool and middleware messages in the interaction inventory. */
export const AGENT_INTERACTION_MESSAGES = [
  tool(
    'INVALID_INPUT',
    'batch-limit',
    (d) =>
      `browser_fill_form takes at most ${text(d.limit)} fields per call and this call sent ${text(d.sent)}. Send the first ${text(d.limit)} now, then the remaining ${Number(d.sent) - Number(d.limit)} in a following browser_fill_form call.`,
    ['sent', 'limit'],
    'browser_fill_form',
  ),
  tool(
    'FORM_FIELD_NOT_FOUND',
    'no-match',
    (d) =>
      `No field named "${text(d.query)}" is present. Fields available: ${text(d.candidates)}. browser_observe with kinds: ["field"] lists them all.`,
    ['query', 'candidates'],
    'browser_observe',
  ),
  tool(
    'FORM_FIELD_AMBIGUOUS',
    'same-tier',
    (d) =>
      `"${text(d.query)}" matches different fields: ${text(d.candidates)}. Re-issue with a section-qualified name shown here or an eNN ref.`,
    ['query', 'candidates'],
    'browser_fill_element',
  ),
  tool(
    'STALE_ELEMENT_REF',
    'continuation-cursor',
    (d) =>
      `Inventory cursor ${text(d.ref)} is no longer visible. Call browser_observe without after to restart the inventory.`,
    ['ref'],
    'browser_observe',
  ),
  tool(
    'STALE_ELEMENT_REF',
    'unverified-replacement',
    (d) =>
      `Field ${text(d.ref)} was replaced and its identity could not be verified. Candidates: ${text(d.candidates)}. Call browser_observe to choose a current ref.`,
    ['ref', 'candidates'],
    'browser_observe',
  ),
  tool(
    'BRIEF_INVALID',
    'contract-table-missing',
    () =>
      'The task contract asks for a table. Publish a table, or list the table in fulfillment.unmet with the reason.',
    [],
    'result_publish',
  ),
  tool(
    'BRIEF_INVALID',
    'contract-field-missing',
    (d) =>
      `The task contract requires the field ${text(d.field)}. Add a column for it (write not shown on source where a row lacks it), or list it in fulfillment.unmet with the reason.`,
    ['field'],
    'result_publish',
  ),
  tool(
    'BRIEF_INVALID',
    'row-uncited',
    (d) =>
      `Table row ${text(d.row)} has no row_sources. Cite the source or record each row came from, for example ["S3#r1"].`,
    ['row'],
    'result_publish',
  ),
  tool(
    'BRIEF_INVALID',
    'row-width',
    (d) =>
      `Table row ${text(d.row)} has ${text(d.width)} cells but the table has ${text(d.columns)} columns.`,
    ['row', 'width', 'columns'],
    'result_publish',
  ),
  tool(
    'BRIEF_INVALID',
    'row-sources-length',
    (d) =>
      `row_sources has ${text(d.row_sources)} entries but the table has ${text(d.rows)} rows; give one list per row.`,
    ['row_sources', 'rows'],
    'result_publish',
  ),
  tool(
    'BRIEF_INVALID',
    'reference-unknown',
    (d) =>
      `${text(d.ref)} at ${text(d.pointer)} is not a source this run read. Cite a source_id shown in a tool result: ${text(d.known)}.`,
    ['ref', 'pointer', 'known'],
    'result_publish',
  ),
  tool(
    'BRIEF_INVALID',
    'reference-anchor-unknown',
    (d) =>
      `${text(d.source)} was read, but it has no record ${text(d.ref)}. Cite ${text(d.source)} itself, or a record id shown in its results.`,
    ['ref', 'pointer', 'source'],
    'result_publish',
  ),
  tool(
    'BRIEF_INVALID',
    'reference-numeric',
    (d) =>
      `Cite sources by their source_id in brackets, such as [S3], not by number (${text(d.pointer)}).`,
    ['pointer'],
    'result_publish',
  ),
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
      'earlier query, so Yantra stopped asking it and this search was not attempted. Do not ' +
      'search again. Use web_fetch on a URL an earlier result already returned, or finish with ' +
      'result_publish and say that web search was blocked.',
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
  // Shape-aware page reads (FEAT-051). Each coverage phrase states one bound
  // that dropped data and names an engineered way to the rest, or says plainly
  // that there is none; only a pagination link is a real way to more records.
  tool(
    'PAGE_COVERAGE',
    'records-beyond-limit',
    (details) =>
      `${text(details.count)} records beyond the first 25 were not shown` +
      (details.pagination === true
        ? '; pagination links are in links[], and web_fetch of one reads the next page.'
        : '; no tool lists the rest of this page.'),
    ['count', 'pagination'],
    'web_fetch',
  ),
  tool(
    'PAGE_COVERAGE',
    'record-text-cut',
    (details) =>
      `${text(details.count)} record(s) were cut to 400 characters at a segment boundary; no tool returns the rest of their text.`,
    ['count'],
  ),
  tool(
    'PAGE_COVERAGE',
    'links-beyond-limit',
    (details) =>
      `${text(details.count)} links beyond the first 40 were not shown; no tool lists them.`,
    ['count'],
  ),
  tool(
    'PAGE_COVERAGE',
    'tables-beyond-limit',
    (details) =>
      `${text(details.count)} tables beyond the first 10 were not shown; no tool reads them.`,
    ['count'],
  ),
  tool(
    'PAGE_COVERAGE',
    'table-rows-beyond-limit',
    (details) =>
      `Table ${text(details.table)}: ${text(details.count)} rows beyond the first 50 were not shown; no tool reads them.`,
    ['count', 'table'],
  ),
  tool(
    'PAGE_COVERAGE',
    'table-columns-beyond-limit',
    (details) =>
      `Table ${text(details.table)}: columns beyond the first 20 were not shown; no tool reads them.`,
    ['table'],
  ),
  tool(
    'PAGE_COVERAGE',
    'structured-beyond-limit',
    (details) =>
      `${text(details.count)} structured entities beyond the first 25 were not shown; no tool reads them.`,
    ['count'],
  ),
  tool(
    'PAGE_COVERAGE',
    'structured-blocks-skipped',
    (details) =>
      `Structured-data blocks totaling ${text(details.count)} bytes exceeded the read limit and were skipped; no tool reads them.`,
    ['count'],
  ),
  tool(
    'PAGE_COVERAGE',
    'fields-beyond-limit',
    (details) =>
      `${text(details.count)} label/value fields beyond the first 60 were not shown; no tool reads them.`,
    ['count'],
  ),
  tool(
    'PAGE_COVERAGE',
    'snapshot-truncated',
    () =>
      'The page was larger than the read limit, so content past the cut was not analyzed; no tool reads it.',
  ),
  tool(
    'PAGE_COVERAGE',
    'text-excerpted',
    () =>
      'The full text did not fit this result: a 1,000-character excerpt is shown, and the full text is stored with this run as capture_ref; no tool reads it back.',
  ),
  tool(
    'PAGE_COVERAGE',
    'links-trimmed',
    (details) =>
      `${text(details.count)} links were trimmed to fit this result; the full analysis is stored with this run, and no tool reads it back.`,
    ['count'],
  ),
  tool(
    'PAGE_COVERAGE',
    'structured-trimmed',
    (details) =>
      `${text(details.count)} structured entities were trimmed to fit this result; the full analysis is stored with this run, and no tool reads it back.`,
    ['count'],
  ),
  tool(
    'PAGE_COVERAGE',
    'table-rows-trimmed',
    (details) =>
      `${text(details.count)} table rows were trimmed to fit this result; the full analysis is stored with this run, and no tool reads it back.`,
    ['count'],
  ),
  tool(
    'PAGE_COVERAGE',
    'records-trimmed',
    (details) =>
      `${text(details.count)} records were trimmed to fit this result; the full analysis is stored with this run, and no tool reads it back.`,
    ['count'],
  ),
  tool(
    'EXTRACTION_EMPTY',
    'nothing-readable',
    (details) =>
      `Nothing readable was found on the page: looked for ${text(details.looked_for)}, and found none. ` +
      'It is not worth fetching again. Use a different URL from search results or from links[] of a page you already read.',
    ['looked_for'],
    'web_fetch',
  ),
  tool(
    'WEB_READ',
    'page-summary',
    () =>
      "This is a summary of the page. web_fetch of this URL returns its full records, links, and tables from this run's store, with no new fetch and no navigation spent.",
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
  // Provenance refusals (FEAT-FP-007, FEAT-051). Both tools refuse a URL no
  // evidence attested, name the same engineered moves — a link from a read
  // page's links[]/records[], or web_search (whose limit: 0 lists URLs without
  // fetching) — and share one "repeated" sentence and one refusal counter.
  tool(
    'URL_NOT_FROM_EVIDENCE',
    'unattested-url',
    (details) =>
      'This URL introduces a path or parameter name that no search result, page read, or visited page attested. You may vary query values on an already-visited URL, but may not invent a new path, parameter name, or identifier. Use a link from links[] or records[] of a page you already read, run web_search, or click through from an observed page.' +
      (details.repeated === true
        ? " Submit the page's form with browser_click on its submit/search control, or reach the target by clicking a search result." +
          REFUSED_AGAIN
        : ''),
    ['repeated'],
    'web_search',
  ),
  tool(
    'URL_NOT_FROM_EVIDENCE',
    'unattested-fetch-url',
    (details) =>
      'This URL came from no search result, no page read in this run, and not the goal, so it was not fetched and nothing was spent. Use a URL from search results, or a link from links[] or records[] of a page you already read. To locate a page, run web_search (limit: 0 lists URLs without fetching anything).' +
      (details.repeated === true ? REFUSED_AGAIN : ''),
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
      `"${text(details.kind).slice(0, 40)}" is not a supported extraction kind. Retry with ` +
      'kind:"content" for the title and readable text, "records" for repeated listing or ' +
      'result items, "links" for pagination, facet, and detail links, "structured" for ' +
      'schema.org data, "tables" for every table, or "table" with index:n for one table.',
    ['kind'],
    'browser_extract',
  ),
  tool(
    'INVALID_INPUT',
    'table-index',
    (details) => {
      const count = Number(details.count);
      return count === 0
        ? 'The page has no tables, so there is no table to read. Use kind:"content" for its text or kind:"records" for repeated items.'
        : `The page has ${text(details.count)} tables (index 0 to ${count - 1}); index ${text(details.index)} is out of range. ` +
            'Retry kind:"table" with an index in that range, or kind:"tables" for all of them.';
    },
    ['count', 'index'],
    'browser_extract',
  ),
  // `task_contract` (FEAT-052). Each cause names the one entry at fault and
  // the correction; re-calling the tool with the full contract is the move.
  tool(
    'INVALID_INPUT',
    'contract-source-host',
    (details) =>
      `"${text(details.entry).slice(0, 80)}" in required_sources is not a site address. Write ` +
      'the site as a hostname such as example.com, or move it to notes, then call ' +
      'task_contract again with the full contract.',
    ['entry'],
    'task_contract',
  ),
  tool(
    'INVALID_INPUT',
    'contract-duplicate',
    (details) =>
      `"${text(details.name).slice(0, 80)}" appears twice (names are compared ignoring case). ` +
      'List each field, filter, and source once, then call task_contract again with the full ' +
      'contract.',
    ['name'],
    'task_contract',
  ),
  tool(
    'INVALID_INPUT',
    'contract-table-fields',
    () =>
      'A table contract needs the fields each row must carry. Add them to required_fields, or ' +
      'use deliverable "answer" or "report", then call task_contract again with the full contract.',
    [],
    'task_contract',
  ),
  tool(
    'INVALID_INPUT',
    'contract-ranking-field',
    (details) =>
      `The ranking orders by "${text(details.field).slice(0, 60)}", which is not one of ` +
      'required_fields. Add it to required_fields or rank by a listed field, then call ' +
      'task_contract again with the full contract.',
    ['field'],
    'task_contract',
  ),
  // FEAT-054 action terms.
  tool(
    'INVALID_INPUT',
    'contract-actions-command',
    () =>
      'research cannot fill forms, take screenshots, or submit, so its contract cannot declare ' +
      'deliverable "actions", fill, artifacts, or effects. Remove them, then call ' +
      'task_contract again with the full contract.',
    [],
    'task_contract',
  ),
  tool(
    'INVALID_INPUT',
    'contract-fill-fields',
    (details) =>
      details.coverage === 'listed'
        ? 'fill.coverage "listed" needs the field names to fill in fill.fields. Name them, or ' +
          'use coverage "all_eligible" for every field, then call task_contract again with the ' +
          'full contract.'
        : 'fill.coverage "all_eligible" means every eligible field, so it takes no fill.fields. ' +
          'Remove fill.fields, or use coverage "listed", then call task_contract again with the ' +
          'full contract.',
    ['coverage'],
    'task_contract',
  ),
  // `effects.submit: forbidden` (FEAT-054). Refused before any prompt; the
  // engineered next move is to leave the form unsubmitted and finish.
  tool(
    'SUBMIT_FORBIDDEN',
    'structural',
    (details) =>
      `Not clicked: "${text(details.name).slice(0, 80)}" would submit the form, and the task ` +
      'contract says effects.submit is forbidden. Leave the form unsubmitted; continue with the ' +
      'remaining items or finish with result_publish.',
    ['name'],
    'result_publish',
  ),
  tool(
    'SUBMIT_FORBIDDEN',
    'name',
    (details) =>
      `Not clicked: "${text(details.name).slice(0, 80)}" reads as a submit action, and the ` +
      'task contract says effects.submit is forbidden. Leave the form unsubmitted; continue ' +
      'with the remaining items or finish with result_publish.',
    ['name'],
    'result_publish',
  ),
  tool(
    'SUBMIT_FORBIDDEN',
    'nested-workflow',
    (details) =>
      `Not run: the saved workflow "${text(details.name).slice(0, 64)}" clicks, and the task ` +
      'contract says effects.submit is forbidden, so it could submit a form. Do the remaining ' +
      'items with the browser tools or finish with result_publish.',
    ['name'],
    'result_publish',
  ),
  tool(
    'CONTRACT_REQUIRED',
    'missing',
    () =>
      'This task has no declared contract, so its result cannot be judged. Call task_contract ' +
      'with the deliverable and every requirement the goal states, including fill, artifacts, ' +
      'and effects for page actions, then call result_publish again.',
    [],
    'task_contract',
  ),
  tool(
    'CONTRACT_REVISION_LIMIT',
    'revisions',
    () =>
      'The contract is fixed at revision 3. Continue with the evidence the goal needs and ' +
      'publish; state any misreading in the result.',
    [],
    'result_publish',
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
