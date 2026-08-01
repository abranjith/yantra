/** Resolve CLI template references into one parsed manifest and provenance record. */

import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve, sep } from 'node:path';

import type { ActiveReportTemplate } from '@yantra/agent';
import {
  FileTemplateStore,
  normalizeTemplateSlug,
  parseTemplate,
  templatesRoot,
} from '@yantra/core';
import { CommanderError } from 'commander';
import prompts from 'prompts';

/** Identical help text used by every agentic command. */
export const TEMPLATE_OPTION_DESCRIPTION =
  'render the result with a saved name, tag, or Markdown template path';

/** Identical validation message for deterministic/template combinations. */
export const TEMPLATE_LLM_GUARD = 'templates require LLM mode; drop --no-llm or drop --template';

/** Injectable boundaries for deterministic reference-resolution tests. */
export interface TemplateReferenceDeps {
  readonly store?: FileTemplateStore;
  readonly cwd?: string;
  readonly isTty?: boolean;
  readonly choose?: (names: readonly string[]) => Promise<string | null>;
}

/** Validation failure raised before an agent run or provider is constructed. */
export class TemplateReferenceError extends CommanderError {
  public constructor(message: string) {
    super(1, 'yantra.template.invalid-reference', message);
  }
}

/**
 * Resolve an explicit or inferred path, saved name, or tag reference.
 *
 * Prefixes win first, path-shaped unprefixed values win second, exact saved
 * names win third, and tags are the final fallback. Ambiguous tags are only
 * interactive on an attended TTY.
 */
export async function resolveTemplateRef(
  ref: string,
  deps: TemplateReferenceDeps = {},
): Promise<ActiveReportTemplate> {
  const value = ref.trim();
  const store = deps.store ?? new FileTemplateStore(templatesRoot());
  const cwd = deps.cwd ?? process.cwd();
  const isTty = deps.isTty ?? process.stdin.isTTY === true;

  if (value.startsWith('path:')) return resolvePath(value.slice(5), cwd);
  if (value.startsWith('name:')) return resolveName(value.slice(5), store);
  if (value.startsWith('tag:')) return resolveTag(value.slice(4), store, isTty, deps.choose);
  if (isPathShape(value)) return resolvePath(value, cwd);
  if (await store.exists(value).catch(() => false)) return resolveName(value, store);
  return resolveTag(value, store, isTty, deps.choose);
}

async function resolvePath(raw: string, cwd: string): Promise<ActiveReportTemplate> {
  const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new TemplateReferenceError(`Template path does not exist or cannot be read: ${path}`);
  }
  const manifest = parseOrThrow(text, path);
  const derivedName = normalizeTemplateSlug(basename(path, '.md'));
  const name = manifest.name ?? (derivedName.length > 0 ? derivedName : null);
  return { manifest: { ...manifest, name }, source: 'path', path, name };
}

async function resolveName(name: string, store: FileTemplateStore): Promise<ActiveReportTemplate> {
  let text: string;
  try {
    text = await store.load(name);
  } catch {
    throw new TemplateReferenceError(
      await unavailableMessage(`Unknown template name "${name}"`, store),
    );
  }
  const manifest = parseOrThrow(text, store.pathFor(name));
  return {
    manifest: { ...manifest, name },
    source: 'saved',
    path: null,
    name,
  };
}

async function resolveTag(
  tag: string,
  store: FileTemplateStore,
  isTty: boolean,
  choose: TemplateReferenceDeps['choose'],
): Promise<ActiveReportTemplate> {
  const normalized = normalizeTemplateSlug(tag);
  const all = await store.list();
  const matches = all.filter((entry) => entry.tags.includes(normalized));
  if (matches.length === 0) {
    throw new TemplateReferenceError(
      await unavailableMessage(`No template matches tag "${tag}"`, store),
    );
  }
  if (matches.length === 1) return resolveName(matches[0]!.name, store);
  const names = matches.map((entry) => entry.name).sort();
  if (!isTty) {
    throw new TemplateReferenceError(
      `Template tag "${tag}" is ambiguous; matching templates: ${names.join(', ')}`,
    );
  }
  const selected = await (choose ?? promptForChoice)(names);
  if (selected === null) throw new TemplateReferenceError('Template selection was cancelled.');
  return resolveName(selected, store);
}

function parseOrThrow(text: string, label: string) {
  const parsed = parseTemplate(text);
  if (parsed.isOk) return parsed.value;
  throw new TemplateReferenceError(
    `Template ${label} is invalid:\n${parsed.error
      .map((issue) => `line ${issue.line}: ${issue.message}`)
      .join('\n')}`,
  );
}

async function unavailableMessage(prefix: string, store: FileTemplateStore): Promise<string> {
  const names = (await store.list()).map((entry) => entry.name).sort();
  return `${prefix}. Available templates: ${names.length === 0 ? '(none)' : names.join(', ')}`;
}

function isPathShape(value: string): boolean {
  return (
    value.startsWith('.') ||
    value.endsWith('.md') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes(sep)
  );
}

async function promptForChoice(names: readonly string[]): Promise<string | null> {
  const answer = (await prompts({
    type: 'select',
    name: 'name',
    message: 'Choose a report template',
    choices: names.map((name) => ({ title: name, value: name })),
  })) as { name?: unknown };
  return typeof answer.name === 'string' ? answer.name : null;
}
