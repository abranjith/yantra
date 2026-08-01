/** Filesystem-backed local report-template library. */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { TemplateManifest } from '@yantra/protocol';

import { parseTemplate } from './parse.js';

const TEMPLATE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Options controlling collision behavior when saving a template. */
export interface TemplateSaveOptions {
  /** Overwrite an existing template when true. */
  readonly force?: boolean;
}

/** Parsed, display-safe projection of one saved template. */
export interface TemplateSummary {
  /** Filename stem and saved template identity. */
  readonly name: string;
  /** Normalized tags from frontmatter. */
  readonly tags: readonly string[];
  /** Optional frontmatter description. */
  readonly description: string | null;
  /** Number of declared slots, including reserved sources. */
  readonly slotCount: number;
  /** Filesystem modification timestamp. */
  readonly modified: Date;
  /** Absolute or constructor-relative on-disk path. */
  readonly path: string;
}

/** Raised when a save would overwrite an existing template without force. */
export class TemplateCollisionError extends Error {
  public override readonly name = 'TemplateCollisionError';

  /** Create a collision error for a saved template name. */
  public constructor(public readonly templateName: string) {
    super(`Template "${templateName}" already exists. Pass force:true to overwrite.`);
  }
}

/** Raised when a template-store operation cannot be completed safely. */
export class TemplateStoreError extends Error {
  public override readonly name = 'TemplateStoreError';

  /** Create an operation-specific, path-safe store error. */
  public constructor(
    public readonly op: 'load' | 'save' | 'remove' | 'validate',
    public readonly templateName: string,
    cause?: unknown,
  ) {
    super(
      op === 'validate'
        ? `Invalid template name "${templateName}"; expected ^[a-z0-9][a-z0-9-]{0,63}$.`
        : `Template store ${op} failed for "${templateName}".`,
      cause === undefined ? undefined : { cause },
    );
  }
}

/**
 * Atomic filesystem store for reusable Markdown report templates.
 *
 * Saved files live at `<root>/<name>.md`. Writes stage to a sibling `.tmp`
 * file and rename into place, and listing ignores unreadable or unparsable
 * Markdown so one damaged file cannot hide the rest of the library.
 */
export class FileTemplateStore {
  /** Create a store rooted at the supplied templates directory. */
  public constructor(private readonly root: string) {}

  /** Return the path used for a validated saved name. */
  public pathFor(name: string): string {
    this.assertName(name);
    return join(this.root, `${name}.md`);
  }

  /** Read the raw Markdown for a saved template. */
  public async load(name: string): Promise<string> {
    this.assertName(name);
    try {
      return await readFile(this.pathFor(name), 'utf8');
    } catch (cause) {
      throw new TemplateStoreError('load', name, cause);
    }
  }

  /** Save raw Markdown atomically, rejecting collisions unless forced. */
  public async save(
    name: string,
    text: string,
    options: TemplateSaveOptions = {},
  ): Promise<string> {
    this.assertName(name);
    if (options.force !== true && (await this.exists(name))) {
      throw new TemplateCollisionError(name);
    }
    const finalPath = this.pathFor(name);
    const tmpPath = `${finalPath}.tmp`;
    try {
      await mkdir(this.root, { recursive: true });
      await writeFile(tmpPath, text, 'utf8');
      await rename(tmpPath, finalPath);
      return finalPath;
    } catch (cause) {
      await unlink(tmpPath).catch(() => undefined);
      throw new TemplateStoreError('save', name, cause);
    }
  }

  /**
   * List valid saved templates in modification-time-descending order.
   * Missing directories and damaged/non-Markdown entries are ignored.
   */
  public async list(): Promise<TemplateSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return [];
    }

    const summaries = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.md'))
        .map(async (entry): Promise<TemplateSummary | null> => {
          const name = basename(entry, '.md');
          if (!TEMPLATE_NAME_PATTERN.test(name)) return null;
          const path = join(this.root, entry);
          try {
            const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
            const parsed = parseTemplate(text);
            if (!parsed.isOk) return null;
            return summaryOf(name, path, parsed.value, info.mtime);
          } catch {
            return null;
          }
        }),
    );
    return summaries
      .filter((summary): summary is TemplateSummary => summary !== null)
      .sort(
        (left, right) =>
          right.modified.getTime() - left.modified.getTime() || left.name.localeCompare(right.name),
      );
  }

  /** Remove one saved template. */
  public async remove(name: string): Promise<void> {
    this.assertName(name);
    try {
      await unlink(this.pathFor(name));
    } catch (cause) {
      throw new TemplateStoreError('remove', name, cause);
    }
  }

  /** Return true exactly when the saved template file exists. */
  public async exists(name: string): Promise<boolean> {
    this.assertName(name);
    try {
      await stat(this.pathFor(name));
      return true;
    } catch {
      return false;
    }
  }

  private assertName(name: string): void {
    if (!TEMPLATE_NAME_PATTERN.test(name)) throw new TemplateStoreError('validate', name);
  }
}

function summaryOf(
  name: string,
  path: string,
  manifest: TemplateManifest,
  modified: Date,
): TemplateSummary {
  return {
    name,
    tags: [...manifest.tags],
    description: manifest.description,
    slotCount: manifest.slots.length,
    modified,
    path,
  };
}
