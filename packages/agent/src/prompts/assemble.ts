import { createHash } from 'node:crypto';

import type { ToolCatalog, ToolDefinition } from '@yantra/protocol';
import type { SchemaVersion } from '@yantra/protocol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssembleOpts {
  readonly toolCatalog: ToolCatalog;
  readonly schemaVersion: SchemaVersion;
  readonly guidanceMarkdown: string;
}

export interface SystemPromptAssembly {
  readonly text: string;
  readonly schemaVersion: SchemaVersion;
  readonly toolCatalogHash: string;
  readonly guidanceHash: string;
  readonly fullHash: string;
}

// ---------------------------------------------------------------------------
// Pure assembly function
// ---------------------------------------------------------------------------

/**
 * Assembles the deterministic system prompt fed to the LLM.
 *
 * Pure function: same inputs always produce the same `fullHash`.
 * Tool definitions are sorted by name for canonical ordering so input-order
 * changes do not perturb the output.
 */
export function assemble(opts: AssembleOpts): SystemPromptAssembly {
  const { toolCatalog, schemaVersion, guidanceMarkdown } = opts;

  const sortedTools = [...toolCatalog].sort((a, b) => a.name.localeCompare(b.name));

  const toolSection = renderToolCatalog(sortedTools);
  const header = buildHeader(schemaVersion);
  const footer = buildFooter(schemaVersion);

  const text = [header, guidanceMarkdown.trim(), toolSection, footer].join('\n\n---\n\n');

  const guidanceHash = sha256(guidanceMarkdown);
  const toolCatalogHash = sha256(toolSection);
  const fullHash = sha256(text);

  return { text, schemaVersion, toolCatalogHash, guidanceHash, fullHash };
}

/**
 * Assembles the system prompt for free-form summarization (no tool catalog).
 */
export function assembleSummarize(opts: {
  readonly schemaVersion: SchemaVersion;
  readonly guidanceMarkdown: string;
}): SystemPromptAssembly {
  const { schemaVersion, guidanceMarkdown } = opts;

  const header =
    `You are Yantra's content summarizer. Schema version: ${schemaVersion}. ` +
    'Produce a concise, accurate summary of the provided content in plain text. ' +
    'Do not hallucinate. Do not invent facts not present in the input.';

  const text = [header, guidanceMarkdown.trim()].join('\n\n---\n\n');

  const guidanceHash = sha256(guidanceMarkdown);
  const toolCatalogHash = sha256('');
  const fullHash = sha256(text);

  return { text, schemaVersion, toolCatalogHash, guidanceHash, fullHash };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function buildHeader(schemaVersion: SchemaVersion): string {
  return (
    `You are Yantra's plan generator. Schema version: ${schemaVersion}. ` +
    'Emit a Plan that conforms exactly to the tool-call schema below.'
  );
}

function buildFooter(schemaVersion: SchemaVersion): string {
  return (
    `Emit schema_version: "${schemaVersion}". ` +
    'Plans must contain 1–64 steps. Step IDs are s1, s2, s3, ...'
  );
}

function renderToolCatalog(tools: ToolDefinition[]): string {
  if (tools.length === 0) {
    return '## Available Step Types\n\n(none)';
  }

  const lines: string[] = ['## Available Step Types'];
  for (const tool of tools) {
    lines.push('');
    lines.push(`### ${tool.name}`);
    lines.push(tool.description);
  }
  return lines.join('\n');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
