import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AuditLogWriteError } from './errors.js';

export interface AgentJsonlEntry {
  readonly ts: string;
  readonly task_id: string;
  readonly step_id: string | null;
  readonly direction: 'request' | 'response';
  readonly model: string;
  readonly prompt_sanitized: string | null;
  readonly response: string | null;
  readonly latency_ms: number | null;
  readonly cost_usd: number | null;
  readonly sanitizer_profile: 'public' | 'read-only-data' | 'authenticated';
  readonly transformations_applied: readonly string[];
}

export interface SecretsJsonlEntry {
  readonly ts: string;
  readonly task_id: string;
  readonly step_id: string;
  readonly key: string;
  readonly outcome: 'resolved' | 'not_found' | 'error';
}

export interface ScopeSummary {
  readonly public: number;
  readonly 'read-only-data': number;
  readonly authenticated: number;
  readonly scope_violations_rejected: number;
}

export interface AuditLogWriter {
  open(runDir: string): Promise<void>;
  appendAgentCall(entry: AgentJsonlEntry): Promise<void>;
  appendSecretResolution(entry: SecretsJsonlEntry): Promise<void>;
  writeScopeSummary(summary: ScopeSummary): Promise<void>;
  close(): Promise<void>;
}

/**
 * Append-only JSONL writer for per-run audit artifacts.
 */
export class FileAuditLogWriter implements AuditLogWriter {
  private runDir: string | null = null;

  public async open(runDir: string): Promise<void> {
    this.runDir = runDir;
    await mkdir(runDir, { recursive: true });

    await this.ensureFile(this.pathFor('agent.jsonl'));
    await this.ensureFile(this.pathFor('secrets.jsonl'));
  }

  public async appendAgentCall(entry: AgentJsonlEntry): Promise<void> {
    await this.appendJsonLine('agent.jsonl', entry);
  }

  public async appendSecretResolution(entry: SecretsJsonlEntry): Promise<void> {
    await this.appendJsonLine('secrets.jsonl', entry);
  }

  public async writeScopeSummary(summary: ScopeSummary): Promise<void> {
    const manifestPath = this.pathFor('manifest.json');

    let manifest: Record<string, unknown> = {};
    try {
      const existing = await readFile(manifestPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return null;
        }
        throw error;
      });

      if (existing !== null) {
        manifest = JSON.parse(existing) as Record<string, unknown>;
      }
    } catch (error) {
      throw this.wrapError('Unable to read existing manifest before scope summary update.', {
        file: 'manifest.json',
        cause: error,
      });
    }

    manifest.scope_summary = summary;

    try {
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    } catch (error) {
      throw this.wrapError('Unable to write scope summary into manifest.json.', {
        file: 'manifest.json',
        cause: error,
      });
    }
  }

  public async close(): Promise<void> {
    // No persistent handles in MVP. Reserved for streaming writer upgrade.
  }

  private async appendJsonLine(fileName: 'agent.jsonl' | 'secrets.jsonl', data: unknown): Promise<void> {
    const line = `${JSON.stringify(data)}\n`;
    const filePath = this.pathFor(fileName);

    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(filePath, 'a');
      await handle.writeFile(line, 'utf8');
      await handle.sync();
    } catch (error) {
      throw this.wrapError(`Unable to append audit line to ${fileName}.`, {
        file: fileName,
        cause: error,
      });
    } finally {
      await handle?.close();
    }
  }

  private async ensureFile(filePath: string): Promise<void> {
    const handle = await open(filePath, 'a');
    await handle.close();
  }

  private pathFor(fileName: string): string {
    if (!this.runDir) {
      throw this.wrapError('Audit writer used before open(runDir).', {
        file: fileName,
      });
    }
    return join(this.runDir, fileName);
  }

  private wrapError(
    message: string,
    details: {
      readonly file: string;
      readonly cause?: unknown;
    },
  ): AuditLogWriteError {
    const runId = this.runDir?.split(/[/\\]/).pop() ?? 'unknown';
    return new AuditLogWriteError(message, {
      runId,
      file: details.file,
      cause: details.cause,
    });
  }
}
