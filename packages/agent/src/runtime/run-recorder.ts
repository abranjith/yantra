import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileUsageWriter, ToolCallWriter, type ToolAuditEntryInput } from '@yantra/core';
import { readManifest, writeManifest, type RunManifest } from '@yantra/core/workflow/replay';
import { AgentManifestSection, type AgentManifestSectionType } from '@yantra/protocol';

import type {
  AgentEvent,
  AgentModelSelection,
  AgentRunResult,
  AgentSession,
  AgentUsage,
} from '../provider/types.js';

import { hashToolCatalog, sha256Text, type HashableToolDefinition } from './catalog-hash.js';
import { PROMPT_VERSION } from './prompt.js';

/** Inputs needed to attach stable persistence to an open agent session. */
export interface RunRecorderOptions {
  readonly runId: string;
  readonly runDir: string;
  readonly session: AgentSession;
  readonly model: AgentModelSelection;
  readonly systemPrompt: string;
  readonly tools: readonly HashableToolDefinition[];
  /** Test/embedding override; production resolves the installed SDK package. */
  readonly sdkVersion?: string;
}

/**
 * Projects an open provider session into stable Yantra run artifacts.
 *
 * Use {@link RunRecorder.open} after the provider session opens, then call
 * {@link close} after the session has finalized its raw JSONL file.
 */
export class RunRecorder {
  private readonly startedCalls = new Map<string, number>();
  private readonly turnUsage: AgentUsage[] = [];
  private readonly unsubscribe: () => void;
  private eventTail: Promise<void> = Promise.resolve();
  private recordingError: Error | undefined;
  private closePromise: Promise<void> | null = null;

  private constructor(
    private readonly options: RunRecorderOptions,
    private readonly agent: AgentManifestSectionType,
    private readonly toolCalls: ToolCallWriter,
    private readonly usage: FileUsageWriter,
  ) {
    this.unsubscribe = options.session.subscribe((event) => this.enqueueEvent(event));
  }

  /**
   * Writes the complete manifest agent section for an open session.
   *
   * @param options Run, session, prompt, model, and catalog metadata.
   * @returns A recorder ready to consume session lifecycle events.
   */
  public static async open(options: RunRecorderOptions): Promise<RunRecorder> {
    const sdkVersion = options.sdkVersion ?? (await resolvePiSdkVersion());
    const sessionFile = toRunRelativePath(options.runDir, options.session.logPath);
    const agent = AgentManifestSection.parse({
      adapter: 'pi-coding-agent',
      sdk_version: sdkVersion,
      provider: options.model.provider,
      model: options.model.id,
      thinking: options.model.thinking ?? 'off',
      auth_source: options.session.authSource,
      session_id: options.session.id,
      session_file: sessionFile,
      prompt_version: PROMPT_VERSION,
      prompt_hash: sha256Text(options.systemPrompt),
      tool_catalog_hash: hashToolCatalog(options.tools),
    });
    const recorder = new RunRecorder(
      options,
      agent,
      ToolCallWriter.forRun(options.runDir),
      new FileUsageWriter(options.runDir),
    );
    await recorder.writeAgentSection();
    return recorder;
  }

  /**
   * Rewrites the final provider session pointer after session teardown.
   *
   * @param result Optional terminal result used to reconcile aggregate usage.
   * @returns Nothing once the atomic manifest update is durable. Idempotent.
   */
  public async close(result?: AgentRunResult): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closePromise = (async () => {
      this.unsubscribe();
      await this.eventTail;
      await this.toolCalls.close();
      await this.usage.mergeAgentUsage(reconcileAgentUsage(this.turnUsage, result?.usage));
      await this.usage.close();
      await this.writeAgentSection();
      if (this.recordingError !== undefined) {
        throw this.recordingError;
      }
    })();
    return this.closePromise;
  }

  private async writeAgentSection(): Promise<void> {
    const manifest: RunManifest = await readManifest(this.options.runDir);
    if (manifest.runId !== this.options.runId) {
      throw new Error(
        `Run recorder expected manifest ${this.options.runId}, found ${manifest.runId}.`,
      );
    }
    await writeManifest(this.options.runDir, { ...manifest, agent: this.agent });
  }

  private enqueueEvent(event: AgentEvent): void {
    this.eventTail = this.eventTail
      .then(() => this.recordEvent(event))
      .catch((error: unknown) => {
        this.recordingError ??= error instanceof Error ? error : new Error(String(error));
      });
  }

  private async recordEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'tool_started': {
        this.startedCalls.set(event.callId, Date.parse(event.at));
        await this.toolCalls.append(
          this.makeToolEntry(event, {
            phase: 'start',
            input_sanitized: event.input,
            output_sanitized: null,
            status: null,
            duration_ms: null,
            error_code: null,
            confirmation_id: null,
          }),
        );
        return;
      }
      case 'tool_finished': {
        const startedAt = this.startedCalls.get(event.callId);
        this.startedCalls.delete(event.callId);
        const metadata = readToolResultMetadata(event.output);
        const endAt = Date.parse(event.at);
        const duration =
          startedAt === undefined || Number.isNaN(startedAt) || Number.isNaN(endAt)
            ? null
            : Math.max(0, endAt - startedAt);
        await this.toolCalls.append(
          this.makeToolEntry(event, {
            phase: 'end',
            input_sanitized: null,
            output_sanitized: event.output,
            status: metadata.status ?? (event.isError ? 'error' : 'ok'),
            duration_ms: duration,
            error_code: metadata.errorCode,
            confirmation_id: metadata.confirmationId,
          }),
        );
        return;
      }
      case 'turn_finished':
        this.turnUsage.push(event.usage);
        return;
      case 'assistant_text':
      case 'failed':
        return;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  private makeToolEntry(
    event: Extract<AgentEvent, { type: 'tool_started' | 'tool_finished' }>,
    phaseFields: Omit<ToolAuditEntryInput, 'ts' | 'run_id' | 'session_id' | 'call_id' | 'tool'>,
  ): ToolAuditEntryInput {
    return {
      ts: event.at,
      run_id: this.options.runId,
      session_id: this.options.session.id,
      call_id: event.callId,
      tool: event.tool,
      ...phaseFields,
    };
  }
}

/** Resolves the installed Pi SDK version from its package metadata at runtime. */
export async function resolvePiSdkVersion(): Promise<string> {
  const packagePath = fileURLToPath(
    new URL('../../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url),
  );
  const parsed = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('Installed @earendil-works/pi-coding-agent package has no version.');
  }
  return parsed.version;
}

function toRunRelativePath(runDir: string, sessionPath: string): string {
  const result = relative(resolve(runDir), resolve(sessionPath)).replaceAll('\\', '/');
  if (result.length === 0 || result === '..' || result.startsWith('../')) {
    throw new Error('Agent session file must be contained by the owning run directory.');
  }
  return result;
}

function readToolResultMetadata(output: unknown): {
  readonly status: 'ok' | 'error' | 'denied' | 'aborted' | null;
  readonly errorCode: string | null;
  readonly confirmationId: string | null;
} {
  if (output === null || typeof output !== 'object') {
    return { status: null, errorCode: null, confirmationId: null };
  }
  const record = output as Readonly<Record<string, unknown>>;
  const status =
    record.status === 'ok' ||
    record.status === 'error' ||
    record.status === 'denied' ||
    record.status === 'aborted'
      ? record.status
      : null;
  const errorCode = readOptionalString(record.error_code ?? record.errorCode);
  const confirmationId = readOptionalString(record.confirmation_id ?? record.confirmationId);
  return { status, errorCode, confirmationId };
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function reconcileAgentUsage(
  turns: readonly AgentUsage[],
  finalUsage: AgentUsage | undefined,
): {
  readonly turns: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cost_usd: number | null;
} {
  return {
    turns:
      turns.length > 0
        ? turns.reduce((sum, usage) => sum + usage.turns, 0)
        : (finalUsage?.turns ?? 0),
    input_tokens: sumReported(turns, 'inputTokens') ?? finalUsage?.inputTokens ?? null,
    output_tokens: sumReported(turns, 'outputTokens') ?? finalUsage?.outputTokens ?? null,
    cost_usd: sumReported(turns, 'costUsd') ?? finalUsage?.costUsd ?? null,
  };
}

function sumReported(
  turns: readonly AgentUsage[],
  field: 'inputTokens' | 'outputTokens' | 'costUsd',
): number | undefined {
  if (turns.length === 0 || turns.some((usage) => usage[field] === undefined)) return undefined;
  return turns.reduce((sum, usage) => sum + (usage[field] ?? 0), 0);
}
