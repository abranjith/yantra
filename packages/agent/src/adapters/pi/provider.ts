/**
 * `PiAgentProvider` — the real Pi adapter behind the `AgentProvider` seam
 * (FEAT-022 TASK-004).
 *
 * Responsibilities: build the pinned environment (environment.ts), resolve
 * the model with typed failures, open a Pi session with built-ins disabled
 * and only Yantra custom tools registered, normalize/sanitize the event
 * stream (event-map.ts), and place the session file under the owning run
 * (session-file.ts). Everything Pi-specific stays inside this directory.
 */

import {
  createAgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import pino from 'pino';

import {
  AgentAuthUnavailableError,
  AgentModelNotFoundError,
  AgentSessionStartFailedError,
} from '../../errors.js';
import type {
  AgentError,
  AgentEvent,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentSessionOptions,
  AgentUsage,
} from '../../provider/types.js';

import {
  PI_DEFAULT_CUSTOM_CONTEXT_WINDOW,
  checkCustomModelContextWindow,
  createPiEnvironment,
} from './environment.js';
import {
  createDefaultPiEventMapContext,
  extractTerminalState,
  mapPiEvent,
  type PiEventMapContext,
  type PiTerminalState,
} from './event-map.js';
import { createRunLocalSession, type RunLocalSession } from './session-file.js';

const logger = pino({ name: 'pi-agent-provider', level: process.env.LOG_LEVEL ?? 'info' });

type PiThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>;

const THINKING_LEVELS: readonly PiThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * The exact structural surface of a Pi session the adapter consumes.
 * Tests inject stubs satisfying this shape; the real `AgentSession` class
 * from the SDK satisfies it structurally.
 */
export interface PiSessionLike {
  readonly sessionId: string;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

/** Factory that turns SDK options into a live Pi session (test seam). */
export type PiSessionFactory = (
  options: CreateAgentSessionOptions,
) => Promise<{ readonly session: PiSessionLike }>;

/** Constructor dependencies for {@link PiAgentProvider}. */
export interface PiAgentProviderOptions {
  /** Base data directory override (tests inject a temp dir). */
  readonly dataDir?: string;
  /** Documented opt-in: personal pi `auth.json` path for managed auth. */
  readonly personalPiAuthPath?: string;
  /** Resolves a Yantra `SecretRef` for `runtime-key` auth. */
  readonly resolveSecret?: (secretRef: string) => Promise<string>;
  /**
   * Yantra custom tools for this session (Pi `defineTool` definitions,
   * supplied by FEAT-024+). Built-in Pi tools are always disabled; the
   * session's tool allowlist is exactly the names listed here.
   */
  readonly customTools?: readonly ToolDefinition[];
  /** Session factory override (module-level test injection, never network). */
  readonly createSession?: PiSessionFactory;
  /** Sanitizer/clock override for event mapping (tests). */
  readonly mapContext?: PiEventMapContext;
}

/**
 * Real Pi adapter implementing the `AgentProvider` seam.
 *
 * @example
 *   const provider = new PiAgentProvider({ customTools: createYantraTools(services) });
 *   const session = await provider.open({
 *     runId, runDir, cwd,
 *     model: { provider: 'anthropic', id: 'claude-sonnet-5' },
 *     auth: { mode: 'managed' },
 *     systemPrompt,
 *   });
 */
export class PiAgentProvider implements AgentProvider {
  private readonly createSession: PiSessionFactory;
  private readonly mapContext: PiEventMapContext;

  public constructor(private readonly options: PiAgentProviderOptions = {}) {
    this.createSession = options.createSession ?? createAgentSession;
    this.mapContext = options.mapContext ?? createDefaultPiEventMapContext();
  }

  /**
   * Open a fresh Pi-backed session for one Yantra run.
   *
   * @param options Seam session options (plan §4).
   * @returns The live normalized session.
   * @throws AgentAuthUnavailableError when no credential source resolves.
   * @throws AgentModelNotFoundError when the provider/model pair is unknown.
   * @throws AgentSessionStartFailedError for any other startup failure
   *   (including an invalid thinking level).
   */
  public async open(options: AgentSessionOptions): Promise<AgentSession> {
    const environment = await createPiEnvironment({
      cwd: options.cwd,
      systemPrompt: options.systemPrompt,
      provider: options.model.provider,
      auth: options.auth,
      ...(this.options.dataDir !== undefined ? { dataDir: this.options.dataDir } : {}),
      ...(this.options.personalPiAuthPath !== undefined
        ? { personalPiAuthPath: this.options.personalPiAuthPath }
        : {}),
      ...(this.options.resolveSecret !== undefined
        ? { resolveSecret: this.options.resolveSecret }
        : {}),
    });

    if (environment.authSource === 'unavailable') {
      throw new AgentAuthUnavailableError(
        options.model.provider,
        'managed store (pinned auth.json), runtime key overrides, provider environment variables',
        `Set the provider's API key environment variable, seed the managed store, or configure a ` +
          `runtime-key secret reference — see docs/model-configuration.md.`,
      );
    }

    const model = environment.modelRegistry.find(options.model.provider, options.model.id);
    if (model === undefined) {
      const known = environment.modelRegistry
        .getAll()
        .filter((candidate) => candidate.provider === options.model.provider)
        .map((candidate) => candidate.id)
        .slice(0, 8);
      const availableHint =
        known.length > 0
          ? `Known ${options.model.provider} models include: ${known.join(', ')}.`
          : `No models are registered for provider "${options.model.provider}".`;
      throw new AgentModelNotFoundError(options.model.provider, options.model.id, availableHint);
    }

    const thinkingLevel = normalizeThinkingLevel(options.model.thinking);

    // A models.json model without a declared contextWindow gets Pi's 128k
    // default, so compaction never engages — and a small serving runtime
    // (e.g. Ollama's default num_ctx of 4096) then silently truncates the
    // prompt, dropping the system prompt, goal, and tools mid-task. Warn
    // actionably; the session itself may still be viable for short tasks.
    const contextCheck = await checkCustomModelContextWindow(
      environment.modelsPath,
      options.model.provider,
      options.model.id,
    );
    if (contextCheck.kind === 'undeclared') {
      logger.warn(
        {
          provider: options.model.provider,
          model: options.model.id,
          assumedContextWindow: PI_DEFAULT_CUSTOM_CONTEXT_WINDOW,
          modelsPath: environment.modelsPath,
        },
        `models.json does not declare "contextWindow" for ${options.model.provider}/${options.model.id}; ` +
          `Pi assumes ${PI_DEFAULT_CUSTOM_CONTEXT_WINDOW} tokens. If the model server enforces a smaller ` +
          'window (Ollama defaults num_ctx to 4096), prompts are silently truncated and the agent can lose ' +
          'its goal and tools mid-run. Declare "contextWindow" to match the server limit and raise the ' +
          'server limit (e.g. OLLAMA_CONTEXT_LENGTH) for agentic use — see docs/model-configuration.md.',
      );
    }

    const runLocal = await createRunLocalSession({ runDir: options.runDir, cwd: options.cwd });

    const toolNames = (this.options.customTools ?? []).map((tool) => tool.name);
    const sessionOptions: CreateAgentSessionOptions = {
      cwd: options.cwd,
      agentDir: environment.agentDir,
      authStorage: environment.authStorage,
      modelRegistry: environment.modelRegistry,
      model,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      // Built-ins (read/bash/edit/write/grep/find/ls) are disabled (§8.1);
      // the allowlist is exactly the Yantra custom tools for this run.
      noTools: 'all',
      tools: toolNames,
      customTools: [...(this.options.customTools ?? [])],
      resourceLoader: environment.resourceLoader,
      sessionManager: runLocal.sessionManager,
      settingsManager: environment.settingsManager,
    };

    let piSession: PiSessionLike;
    try {
      const created = await this.createSession(sessionOptions);
      piSession = created.session;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new AgentSessionStartFailedError(this.mapContext.sanitizeText(reason));
    }

    logger.info(
      {
        runId: options.runId,
        sessionId: piSession.sessionId,
        provider: options.model.provider,
        model: options.model.id,
        authSource: environment.authSource,
        logPath: runLocal.logPath(),
      },
      'agent session opened',
    );

    const authSource =
      environment.authSource === 'models-config' ? 'managed' : environment.authSource;
    return new PiSession(piSession, runLocal, this.mapContext, options.runId, authSource);
  }
}

/** Per-run bookkeeping fed by the internal event subscription. */
interface RunTracker {
  turns: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  costUsd: number | undefined;
  failed: AgentError | undefined;
  terminal: PiTerminalState | undefined;
  aborted: boolean;
}

const DEFAULT_STOP_REASON: Record<AgentRunResult['outcome'], string> = {
  completed: 'stop',
  failed: 'error',
  aborted: 'aborted',
};

/** Seam `AgentSession` wrapping one live Pi session. */
class PiSession implements AgentSession {
  public readonly id: string;
  public readonly logPath: string;

  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly unsubscribeInternal: () => void;
  private currentRun: RunTracker | undefined;
  private closed = false;

  public constructor(
    private readonly piSession: PiSessionLike,
    private readonly runLocal: RunLocalSession,
    private readonly ctx: PiEventMapContext,
    private readonly runId: string,
    public readonly authSource: 'managed' | 'runtime-key' | 'environment',
  ) {
    this.id = piSession.sessionId;
    this.logPath = runLocal.logPath();
    this.unsubscribeInternal = piSession.subscribe((event) => this.handleRawEvent(event));
  }

  public async run(prompt: string): Promise<AgentRunResult> {
    if (this.closed) {
      throw new AgentSessionStartFailedError('run() was called on a closed session');
    }

    const tracker: RunTracker = {
      turns: 0,
      inputTokens: undefined,
      outputTokens: undefined,
      costUsd: undefined,
      failed: undefined,
      terminal: undefined,
      aborted: false,
    };
    this.currentRun = tracker;

    try {
      await this.piSession.prompt(prompt, { expandPromptTemplates: false });
    } catch (err) {
      // open() validates model and auth, so a rejection here is a provider
      // failure surfacing synchronously; normalize it instead of rethrowing.
      const reason = err instanceof Error ? err.message : String(err);
      const error: AgentError = {
        code: 'AGENT_PROVIDER_UNAVAILABLE',
        message: this.ctx.sanitizeText(reason),
      };
      tracker.failed = error;
      this.dispatch({ type: 'failed', error, at: this.ctx.now() });
    } finally {
      this.currentRun = undefined;
    }

    const outcome: AgentRunResult['outcome'] =
      tracker.aborted || tracker.terminal?.stopReason === 'aborted'
        ? 'aborted'
        : tracker.failed !== undefined
          ? 'failed'
          : 'completed';

    const usage: AgentUsage = {
      turns: tracker.turns,
      ...(tracker.inputTokens !== undefined ? { inputTokens: tracker.inputTokens } : {}),
      ...(tracker.outputTokens !== undefined ? { outputTokens: tracker.outputTokens } : {}),
      ...(tracker.costUsd !== undefined ? { costUsd: tracker.costUsd } : {}),
    };

    return {
      outcome,
      stopReason: tracker.terminal?.stopReason ?? DEFAULT_STOP_REASON[outcome],
      usage,
    };
  }

  public subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async abort(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.currentRun !== undefined) {
      this.currentRun.aborted = true;
    }
    await this.piSession.abort();
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribeInternal();
    this.piSession.dispose();
    await this.runLocal.finalize();
    logger.info({ runId: this.runId, sessionId: this.id }, 'agent session closed');
  }

  private handleRawEvent(raw: AgentSessionEvent): void {
    if (raw.type === 'agent_end' && !raw.willRetry && this.currentRun !== undefined) {
      this.currentRun.terminal = extractTerminalState(raw.messages, this.ctx);
    }

    for (const event of mapPiEvent(raw, this.ctx)) {
      if (this.currentRun !== undefined) {
        if (event.type === 'turn_finished') {
          this.currentRun.turns += event.usage.turns;
          this.currentRun.inputTokens = addOptional(
            this.currentRun.inputTokens,
            event.usage.inputTokens,
          );
          this.currentRun.outputTokens = addOptional(
            this.currentRun.outputTokens,
            event.usage.outputTokens,
          );
          this.currentRun.costUsd = addOptional(this.currentRun.costUsd, event.usage.costUsd);
        } else if (event.type === 'failed') {
          this.currentRun.failed = event.error;
        }
      }
      this.dispatch(event);
    }
  }

  private dispatch(event: AgentEvent): void {
    logger.debug({ runId: this.runId, type: event.type }, 'agent event');
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        // A throwing consumer must not break the provider loop or the other
        // listeners; surface it as a warning and continue.
        logger.warn(
          { runId: this.runId, err: err instanceof Error ? err.message : String(err) },
          'agent event listener threw',
        );
      }
    }
  }
}

/** Sum optional usage numbers without materializing zeros the provider never reported. */
function addOptional(current: number | undefined, extra: number | undefined): number | undefined {
  if (extra === undefined) {
    return current;
  }
  return (current ?? 0) + extra;
}

/**
 * Validate the seam's free-form `thinking` string against Pi's levels.
 * Unknown values are a typed startup failure — silently ignoring configured
 * reasoning effort would be a silent degradation.
 */
function normalizeThinkingLevel(thinking: string | undefined): PiThinkingLevel | undefined {
  if (thinking === undefined) {
    return THINKING_LEVELS[4]; // default to "high" if not specified
  }
  const match = THINKING_LEVELS.find((level) => level === thinking);
  if (match === undefined) {
    throw new AgentSessionStartFailedError(
      `Unknown thinking level "${thinking}" — expected one of: ${THINKING_LEVELS.join(', ')}.`,
    );
  }
  return match;
}
