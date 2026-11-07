import type { ActiveReportTemplate } from '@yantra/agent';
import {
  ConfigBrowserSelectionReader,
  FileTemplateStore,
  contentIdentity,
  templatesRoot,
  type BrowserSelection,
  type ExecutionReceiptDraft,
} from '@yantra/core';
import type { ContentIdentity } from '@yantra/protocol';

import type { AgentInvocation } from '../agent-options.js';

import type { CommandContext } from './command-context.js';

/** Compose shared provenance from already-resolved command values. */
export async function draftRunReceipt(
  context: CommandContext,
  path: readonly string[],
  options: {
    readonly agent?: AgentInvocation;
    readonly template?: ActiveReportTemplate;
    readonly browser?: BrowserSelection;
    readonly settings?: Readonly<Record<string, unknown>>;
    readonly content?: readonly ContentIdentity[];
  } = {},
): Promise<ExecutionReceiptDraft> {
  for (const [key, value] of Object.entries(options.settings ?? {}))
    await context.settings.effective(key, value);
  if (
    options.settings?.format === 'json' &&
    (await context.settings.option('json'))?.value === true
  )
    context.settings.record('format', 'json', { kind: 'flag' });
  const agent = options.agent;
  if (agent?.mode === 'llm') {
    const effective = {
      provider: agent.model.provider,
      model: agent.model.id,
      thinking: agent.model.thinking ?? null,
      maxDuration: agent.budgets.wallClockMs,
      maxTokens: agent.budgets.maxProviderTokens,
      toolTimeout: agent.budgets.perToolTimeoutMs,
      toolRetries: agent.budgets.toolRetries,
      confirmTimeout: agent.budgets.confirmationWaitMs,
    };
    for (const [key, value] of Object.entries(effective))
      await context.settings.effective(key, value);
  }
  const configured =
    options.browser === undefined ? await new ConfigBrowserSelectionReader().read() : undefined;
  const selection = options.browser ??
    configured ?? { source: 'auto' as const, executablePath: null };
  const source = options.browser
    ? { kind: 'flag' as const }
    : configured
      ? { kind: 'config' as const, key: 'browser.source' }
      : { kind: 'default' as const };
  context.settings.record('browser', selection.source, source);
  context.settings.record('browserPath', selection.executablePath, source);
  const templatePath =
    options.template?.path ??
    (options.template?.name
      ? new FileTemplateStore(templatesRoot()).pathFor(options.template.name)
      : null);
  const content = [...(options.content ?? [])];
  if (templatePath) content.push(await contentIdentity('template', templatePath));
  return context.settings.draftReceipt(path, { content, browser: { selection, source } });
}
