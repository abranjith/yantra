/** `yantra template` â€” local report-template library management. */

import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

import {
  FileTemplateStore,
  TemplateCollisionError,
  normalizeTemplateSlug,
  normalizeTemplateTags,
  parseTemplate,
  templatesRoot,
  type TemplateParseError,
  type TemplateSummary,
} from '@yantra/core';
import type { TemplateManifest, TemplateSlot } from '@yantra/protocol';
import { CommanderError, Command, Option } from 'commander';
import { stringify } from 'yaml';

import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';

/** Injectable boundaries for template-command unit tests. */
export interface TemplateCommandRuntime {
  /** Saved-template store. */
  readonly store: FileTemplateStore;
  /** Current working directory for relative paths. */
  readonly cwd: string;
  /** Standard output stream. */
  readonly stdout: NodeJS.WritableStream;
  /** Standard error stream. */
  readonly stderr: NodeJS.WritableStream;
}

interface JsonOption {
  readonly json?: boolean;
}

/** Build the complete `template new|save|list|show|lint|remove` command group. */
export function makeTemplateCommand(runtime?: Partial<TemplateCommandRuntime>): Command {
  const resolved = withDefaults(runtime);
  const command = new Command('template').description(
    'Create, validate, save, inspect, and remove report templates.',
  );

  command
    .command('new')
    .description('Create a starter template covering every slot kind.')
    .argument('<name>', 'saved template name')
    .addOption(new Option('--tags <a,b>', 'comma-separated tags'))
    .addOption(new Option('--force', 'overwrite an existing template').default(false))
    .addOption(new Option('--json', 'emit a stable JSON envelope').default(false))
    .action(async (rawName: string, options: JsonOption & { tags?: string; force?: boolean }) => {
      const name = requireName(rawName, resolved);
      const tags = normalizeTemplateTags(splitTags(options.tags));
      const text = starterTemplate(name, tags);
      try {
        const path = await resolved.store.save(name, text, { force: options.force === true });
        if (options.json === true) {
          writeJson(resolved, { kind: 'template_new', name, path, tags });
        } else {
          resolved.stdout.write(`${path}\n`);
        }
      } catch (error) {
        fail(resolved, errorMessage(error), 'yantra.template.new');
      }
    });

  command
    .command('lint')
    .description('Parse a saved template or Markdown path and print its slot manifest.')
    .argument('<name-or-path>', 'saved name or Markdown file path')
    .addOption(new Option('--json', 'emit a stable JSON envelope').default(false))
    .action(async (reference: string, options: JsonOption) => {
      try {
        const target = await readTarget(reference, resolved);
        const parsed = parseTemplate(target.text);
        if (!parsed.isOk) {
          writeParseFailure(resolved, 'template_lint', target.path, parsed.error, options.json);
          throw new CommanderError(1, 'yantra.template.lint', 'Template lint failed.');
        }
        const slots = slotRows(parsed.value);
        if (options.json === true) {
          writeJson(resolved, {
            kind: 'template_lint',
            ok: true,
            path: target.path,
            template: manifestMetadata(parsed.value),
            slots,
          });
        } else {
          resolved.stdout.write(`${renderSlotTable(slots)}\n`);
        }
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        fail(resolved, errorMessage(error), 'yantra.template.lint');
      }
    });

  command
    .command('save')
    .description('Validate and save a Markdown template in the local library.')
    .argument('<path>', 'template Markdown path')
    .addOption(new Option('--name <name>', 'saved name (defaults to frontmatter or filename)'))
    .addOption(new Option('--tags <a,b>', 'replace frontmatter tags'))
    .addOption(new Option('--description <text>', 'replace the frontmatter description'))
    .addOption(new Option('--force', 'overwrite an existing template').default(false))
    .addOption(new Option('--json', 'emit a stable JSON envelope').default(false))
    .action(
      async (
        pathArg: string,
        options: JsonOption & {
          name?: string;
          tags?: string;
          description?: string;
          force?: boolean;
        },
      ) => {
        const path = resolve(resolved.cwd, pathArg);
        let text: string;
        try {
          text = await readFile(path, 'utf8');
        } catch (error) {
          fail(
            resolved,
            `Could not read template path ${path}: ${errorMessage(error)}`,
            'yantra.template.save',
          );
        }
        const parsed = parseTemplate(text!);
        if (!parsed.isOk) {
          writeParseFailure(resolved, 'template_save', path, parsed.error, options.json);
          throw new CommanderError(1, 'yantra.template.save', 'Template save failed.');
        }

        const inferred = basename(path, extname(path));
        const name = requireName(options.name ?? parsed.value.name ?? inferred, resolved);
        const tags =
          options.tags === undefined
            ? [...parsed.value.tags]
            : normalizeTemplateTags(splitTags(options.tags));
        const description =
          options.description === undefined
            ? parsed.value.description
            : options.description.replace(/\s+/gu, ' ').trim() || null;
        const normalized = serializeTemplate(name, description, tags, parsed.value.body);

        try {
          const savedPath = await resolved.store.save(name, normalized, {
            force: options.force === true,
          });
          if (options.json === true) {
            writeJson(resolved, {
              kind: 'template_save',
              name,
              path: savedPath,
              tags,
              description,
              slots: parsed.value.slots.length,
            });
          } else {
            resolved.stdout.write(`Saved ${name} to ${savedPath}\n`);
          }
        } catch (error) {
          fail(resolved, errorMessage(error), 'yantra.template.save');
        }
      },
    );

  command
    .command('list')
    .description('List valid saved report templates.')
    .addOption(new Option('--tag <tag>', 'show only templates carrying this tag'))
    .addOption(new Option('--json', 'emit a stable JSON envelope').default(false))
    .action(async (options: JsonOption & { tag?: string }) => {
      const tag = options.tag === undefined ? null : normalizeTemplateSlug(options.tag);
      const all = await resolved.store.list();
      const items = (tag === null ? all : all.filter((item) => item.tags.includes(tag))).map(
        summaryRow,
      );
      if (options.json === true) {
        writeJson(resolved, { kind: 'template_list', tag, items });
      } else if (items.length === 0) {
        resolved.stdout.write(tag === null ? 'No templates.\n' : `No templates tagged "${tag}".\n`);
      } else {
        for (const item of items) {
          resolved.stdout.write(
            `${item.name.padEnd(24)} slots=${String(item.slotCount).padStart(2)} ` +
              `tags=${item.tags.join(',') || '-'} modified=${item.modified}\n`,
          );
        }
      }
    });

  command
    .command('show')
    .description('Print a saved template and its parsed slots.')
    .argument('<name>', 'saved template name')
    .addOption(new Option('--json', 'emit a stable JSON envelope').default(false))
    .action(async (rawName: string, options: JsonOption) => {
      const name = requireName(rawName, resolved);
      if (!(await resolved.store.exists(name))) {
        const available = (await resolved.store.list()).map((item) => item.name);
        fail(
          resolved,
          `Template "${name}" was not found.${available.length === 0 ? '' : ` Available: ${available.join(', ')}`}`,
          'yantra.template.show',
        );
      }
      const text = await resolved.store.load(name);
      const parsed = parseTemplate(text);
      if (!parsed.isOk) {
        writeParseFailure(
          resolved,
          'template_show',
          resolved.store.pathFor(name),
          parsed.error,
          options.json,
        );
        throw new CommanderError(1, 'yantra.template.show', 'Template show failed.');
      }
      const slots = slotRows(parsed.value);
      if (options.json === true) {
        writeJson(resolved, {
          kind: 'template_show',
          name,
          path: resolved.store.pathFor(name),
          markdown: text,
          template: manifestMetadata(parsed.value),
          slots,
        });
      } else {
        resolved.stdout.write(text);
        if (!text.endsWith('\n')) resolved.stdout.write('\n');
        resolved.stdout.write(`\n${renderSlotTable(slots)}\n`);
      }
    });

  command
    .command('remove')
    .description('Delete a saved report template.')
    .argument('<name>', 'saved template name')
    .addOption(new Option('--json', 'emit a stable JSON envelope').default(false))
    .action(async (rawName: string, options: JsonOption) => {
      const name = requireName(rawName, resolved);
      if (!(await resolved.store.exists(name))) {
        fail(resolved, `Template "${name}" was not found.`, 'yantra.template.remove');
      }
      try {
        await resolved.store.remove(name);
        if (options.json === true)
          writeJson(resolved, { kind: 'template_remove', name, removed: true });
        else resolved.stdout.write(`Removed ${name}.\n`);
      } catch (error) {
        fail(resolved, errorMessage(error), 'yantra.template.remove');
      }
    });

  return command;
}

function withDefaults(runtime?: Partial<TemplateCommandRuntime>): TemplateCommandRuntime {
  return {
    store: runtime?.store ?? new FileTemplateStore(templatesRoot()),
    cwd: runtime?.cwd ?? process.cwd(),
    stdout: runtime?.stdout ?? process.stdout,
    stderr: runtime?.stderr ?? process.stderr,
  };
}

function starterTemplate(name: string, tags: readonly string[]): string {
  return serializeTemplate(
    name,
    'Describe the purpose of this report.',
    tags,
    `# {{ title | text }}

## Summary
{{ summary | markdown, max_words=200 }}

## Highlights
{{ highlights | list, min=1, max=5 }}

## Metrics
{{ metrics | table(Metric, Value) }}

## Sources
{{ sources }}
`,
  );
}

function serializeTemplate(
  name: string,
  description: string | null,
  tags: readonly string[],
  body: string,
): string {
  const frontmatter = stringify({
    name,
    ...(description === null ? {} : { description }),
    tags: [...tags],
  }).trimEnd();
  return `---\n${frontmatter}\n---\n${body.replace(/^\r?\n/u, '')}`;
}

interface SlotRow {
  readonly key: string;
  readonly kind: string;
  readonly heading: string;
  readonly constraints: TemplateSlot['constraints'];
  readonly columns: TemplateSlot['columns'];
}

function slotRows(manifest: TemplateManifest): SlotRow[] {
  return manifest.slots.map((slot) => ({
    key: slot.key,
    kind: slot.kind,
    heading: slot.headingPath.join(' > ') || '(document root)',
    constraints: slot.constraints,
    columns: slot.columns,
  }));
}

function renderSlotTable(rows: ReturnType<typeof slotRows>): string {
  const headings = ['KEY', 'KIND', 'HEADING', 'CONSTRAINTS'];
  const values = rows.map((row) => [row.key, row.kind, row.heading, formatConstraints(row)]);
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...values.map((row) => row[index]?.length ?? 0)),
  );
  return [headings, ...values]
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function formatConstraints(slot: Pick<SlotRow, 'constraints' | 'columns'>): string {
  const values = Object.entries(slot.constraints).map(([key, value]) => `${key}=${value}`);
  if (slot.columns !== null) values.unshift(`columns=${slot.columns.join('|')}`);
  return values.join(', ') || '-';
}

function manifestMetadata(manifest: TemplateManifest): Record<string, unknown> {
  return {
    name: manifest.name,
    description: manifest.description,
    tags: manifest.tags,
    hash: manifest.hash,
    slotCount: manifest.slots.length,
  };
}

function summaryRow(summary: TemplateSummary): Record<string, unknown> & {
  readonly name: string;
  readonly tags: readonly string[];
  readonly slotCount: number;
  readonly modified: string;
} {
  return {
    name: summary.name,
    tags: summary.tags,
    description: summary.description,
    slotCount: summary.slotCount,
    modified: summary.modified.toISOString(),
    path: summary.path,
  };
}

async function readTarget(
  reference: string,
  runtime: TemplateCommandRuntime,
): Promise<{ readonly text: string; readonly path: string }> {
  if (looksLikePath(reference)) {
    const path = resolve(runtime.cwd, reference);
    return { text: await readFile(path, 'utf8'), path };
  }
  const name = requireName(reference, runtime);
  return { text: await runtime.store.load(name), path: runtime.store.pathFor(name) };
}

function looksLikePath(reference: string): boolean {
  return (
    reference.includes('/') ||
    reference.includes('\\') ||
    reference.startsWith('.') ||
    reference.toLowerCase().endsWith('.md')
  );
}

function splitTags(raw: string | undefined): string[] {
  return raw?.split(',') ?? [];
}

function requireName(raw: string, runtime: TemplateCommandRuntime): string {
  const name = normalizeTemplateSlug(raw);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    fail(runtime, `Invalid template name "${raw}".`, 'yantra.template.invalid-name');
  }
  return name;
}

function writeParseFailure(
  runtime: TemplateCommandRuntime,
  kind: string,
  path: string,
  errors: readonly TemplateParseError[],
  json = false,
): void {
  if (json) {
    writeJson(runtime, { kind, ok: false, path, errors });
    return;
  }
  runtime.stderr.write(`Template is invalid: ${path}\n`);
  for (const issue of errors) runtime.stderr.write(`  line ${issue.line}: ${issue.message}\n`);
}

function writeJson(runtime: TemplateCommandRuntime, payload: Record<string, unknown>): void {
  runtime.stdout.write(
    `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, ...payload })}\n`,
  );
}

function fail(runtime: TemplateCommandRuntime, message: string, code: string): never {
  runtime.stderr.write(`${message}\n`);
  throw new CommanderError(1, code, message);
}

function errorMessage(error: unknown): string {
  if (error instanceof TemplateCollisionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
