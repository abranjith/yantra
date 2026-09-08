import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configDir } from '../browser/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BLOCKLIST_PATH = join(__dirname, 'blocklist.default.yaml');

interface BlocklistFile {
  version: number;
  categories: Record<string, string[]>;
  user_rules: string[];
}

/**
 * Host blocklist loaded from YAML.
 *
 * Supports exact host matching and wildcard subdomain matching (`*.example.com`).
 * Hot-reloads from disk via `reload()`.
 */
export class BlocklistImpl {
  private rules: { label: string; pattern: (host: string) => boolean }[] = [];
  private userRulesPath: string;

  constructor(userRulesPath?: string) {
    this.userRulesPath = userRulesPath ?? join(configDir(), 'blocklist.yaml');
  }

  /** Returns the category label if the host is blocked, null otherwise. */
  match(host: string): string | null {
    for (const rule of this.rules) {
      if (rule.pattern(host)) return rule.label;
    }
    return null;
  }

  /** (Re)loads the blocklist from disk. Falls back to the bundled default. */
  async reload(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.userRulesPath, 'utf8');
    } catch {
      try {
        content = await readFile(DEFAULT_BLOCKLIST_PATH, 'utf8');
      } catch {
        this.rules = [];
        return;
      }
    }

    const { parse } = await import('yaml');
    const data = parse(content) as BlocklistFile;
    this.rules = buildRules(data);
  }
}

function buildRules(data: BlocklistFile): { label: string; pattern: (host: string) => boolean }[] {
  const rules: { label: string; pattern: (host: string) => boolean }[] = [];

  for (const [category, hosts] of Object.entries(data.categories ?? {})) {
    for (const host of hosts) {
      rules.push({ label: category, pattern: buildHostMatcher(host) });
    }
  }

  for (const host of data.user_rules ?? []) {
    rules.push({ label: 'user_rules', pattern: buildHostMatcher(host) });
  }

  return rules;
}

function buildHostMatcher(pattern: string): (host: string) => boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // '.example.com'
    return (host: string) => host === pattern.slice(2) || host.endsWith(suffix);
  }
  return (host: string) => host === pattern || host.endsWith('.' + pattern);
}
