/**
 * Agent provider smoke run (FEAT-022 TASK-006).
 *
 * Opens a REAL Pi session against the pinned environment, registers a single
 * `status` custom tool, runs one prompt that invokes it, streams normalized
 * events, and closes cleanly. This is the live acceptance surface for the
 * provider foundation — reachable via `yantra doctor --agent-smoke`.
 *
 * No fallback exists on this path: missing credentials or an unknown model
 * surface as typed `AgentStartupError`s, never as a null client.
 */

import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type {
  AgentAuthSelection,
  AgentEvent,
  AgentModelSelection,
  AgentRunResult,
} from '../../provider/types.js';

import { createPiEnvironment, type PiEnvironmentEnumeration } from './environment.js';
import { PiAgentProvider, type PiSessionFactory } from './provider.js';

/** Version tag of the smoke prompt (recorded in output for reproducibility). */
export const AGENT_SMOKE_PROMPT_VERSION = 'agent-smoke-v1';

const SMOKE_SYSTEM_PROMPT =
  `You are the Yantra agent-runtime smoke check (${AGENT_SMOKE_PROMPT_VERSION}). ` +
  `You have exactly one tool: "status". When asked to check status, call the ` +
  `status tool once and then summarize its result in one short sentence. Do ` +
  `not use any other capability.`;

const SMOKE_USER_PROMPT =
  'Check the runtime status: call the status tool exactly once, then reply ' +
  'with one short sentence summarizing its output.';

/** Options for {@link runAgentSmoke}. */
export interface AgentSmokeOptions {
  /** Model to smoke against. */
  readonly model: AgentModelSelection;
  /** Credential selection; defaults to `managed`. */
  readonly auth?: AgentAuthSelection;
  /** Run identity for the artifact directory. */
  readonly runId: string;
  /** Existing run directory; the session JSONL lands under `<runDir>/agent/`. */
  readonly runDir: string;
  /** Working directory recorded for the session; defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Data-dir override (tests). */
  readonly dataDir?: string;
  /** Personal pi auth.json opt-in (config key `agent.pi_auth_path`). */
  readonly personalPiAuthPath?: string;
  /** Secret resolver for `runtime-key` auth. */
  readonly resolveSecret?: (secretRef: string) => Promise<string>;
  /** Live event callback (rendering); every event is also collected in the report. */
  readonly onEvent?: (event: AgentEvent) => void;
  /** Abort signal — aborts the in-flight run cleanly (Ctrl+C path). */
  readonly signal?: AbortSignal;
  /** Session factory override (test seam; never network in tests). */
  readonly createSession?: PiSessionFactory;
}

/** Outcome of one smoke run. */
export interface AgentSmokeReport {
  /** Provider session id. */
  readonly sessionId: string;
  /** Final session JSONL location (under the run directory). */
  readonly logPath: string;
  /** Terminal run result. */
  readonly result: AgentRunResult;
  /** All normalized events observed, in order. */
  readonly events: readonly AgentEvent[];
  /** True when the `status` tool completed a successful round-trip. */
  readonly statusToolInvoked: boolean;
  /** Effective pinned paths and (empty) ambient resources — plan §8 evidence. */
  readonly enumeration: PiEnvironmentEnumeration;
}

/** The single custom tool registered for the smoke session. */
function createStatusTool(): ToolDefinition {
  return defineTool({
    name: 'status',
    label: 'Status',
    description:
      'Report the Yantra agent-runtime status (platform, Node version). ' +
      'Use only when asked to check the runtime status.',
    parameters: Type.Object({}),
    execute: (_toolCallId, _params) =>
      Promise.resolve({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              platform: process.platform,
              node: process.versions.node,
            }),
          },
        ],
        details: { ok: true },
      }),
  });
}

/**
 * Run the agent provider smoke: open, one tool-using prompt, clean close.
 *
 * @param options See {@link AgentSmokeOptions}.
 * @returns The smoke report (session identity, events, outcome, enumeration).
 * @throws AgentStartupError (typed, plan §9 code) when the session cannot be
 *   opened — absence of credentials is `AGENT_AUTH_UNAVAILABLE`, never a
 *   silent fallback.
 */
export async function runAgentSmoke(options: AgentSmokeOptions): Promise<AgentSmokeReport> {
  const cwd = options.cwd ?? process.cwd();
  const auth = options.auth ?? { mode: 'managed' as const };

  // A parallel environment build purely for the diagnostic enumeration — it
  // shares the same pinned paths as the session's own environment and proves
  // no ambient resource is active (§8.2/§8.11).
  const enumeration = (
    await createPiEnvironment({
      cwd,
      systemPrompt: SMOKE_SYSTEM_PROMPT,
      provider: options.model.provider,
      auth,
      ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
      ...(options.personalPiAuthPath !== undefined
        ? { personalPiAuthPath: options.personalPiAuthPath }
        : {}),
      ...(options.resolveSecret !== undefined ? { resolveSecret: options.resolveSecret } : {}),
    })
  ).enumerate();

  const provider = new PiAgentProvider({
    customTools: [createStatusTool()],
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(options.personalPiAuthPath !== undefined
      ? { personalPiAuthPath: options.personalPiAuthPath }
      : {}),
    ...(options.resolveSecret !== undefined ? { resolveSecret: options.resolveSecret } : {}),
    ...(options.createSession !== undefined ? { createSession: options.createSession } : {}),
  });

  const session = await provider.open({
    runId: options.runId,
    runDir: options.runDir,
    cwd,
    model: options.model,
    auth,
    systemPrompt: SMOKE_SYSTEM_PROMPT,
  });

  const events: AgentEvent[] = [];
  const unsubscribe = session.subscribe((event) => {
    events.push(event);
    options.onEvent?.(event);
  });

  const onAbort = (): void => {
    void session.abort();
  };
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    const result = await session.run(SMOKE_USER_PROMPT);
    const statusToolInvoked = events.some(
      (event) => event.type === 'tool_finished' && event.tool === 'status' && !event.isError,
    );
    return {
      sessionId: session.id,
      logPath: session.logPath,
      result,
      events,
      statusToolInvoked,
      enumeration,
    };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    unsubscribe();
    await session.close();
  }
}
