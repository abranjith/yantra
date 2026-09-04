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
