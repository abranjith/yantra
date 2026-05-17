/**
 * Local type stubs for the pi-agent-core API.
 *
 * pi-agent-core (earendil-works/pi) is the designated LLM client library.
 * These types describe the subset of its API that packages/agent uses.
 * They will be replaced by actual imports once pi-agent-core is installed.
 *
 * @see https://github.com/earendil-works/pi/blob/main/packages/agent/README.md
 */

// ---------------------------------------------------------------------------
// AgentTool — the shape pi-agent-core expects for tool definitions
// ---------------------------------------------------------------------------

export interface AgentToolExecuteResult {
  readonly content: unknown[];
  readonly details: Record<string, unknown>;
}

export interface AgentTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** Typebox schema. We use unknown here since typebox is not installed. */
  readonly parameters: unknown;
  readonly executionMode?: 'sequential' | 'parallel';
  execute(input: unknown): Promise<AgentToolExecuteResult>;
}

// ---------------------------------------------------------------------------
// Event types emitted by pi-agent-core
// ---------------------------------------------------------------------------

export type PiAgentEvent =
  | { readonly kind: 'agent_start'; readonly runId: string }
  | { readonly kind: 'agent_end'; readonly runId: string }
  | { readonly kind: 'turn_start'; readonly turnIndex: number }
  | { readonly kind: 'turn_end'; readonly turnIndex: number }
  | { readonly kind: 'message_start'; readonly messageId: string }
  | { readonly kind: 'message_update'; readonly delta: string }
  | { readonly kind: 'message_end'; readonly messageId: string; readonly stopReason: string }
  | { readonly kind: 'tool_execution_start'; readonly toolName: string; readonly input: unknown }
  | { readonly kind: 'tool_execution_end'; readonly toolName: string; readonly output: unknown };

export interface EventSink {
  onEvent(event: PiAgentEvent): void;
}

// ---------------------------------------------------------------------------
// Agent response shape
// ---------------------------------------------------------------------------

export interface PiToolCall {
  readonly tool: string;
  readonly input: unknown;
  readonly output: unknown;
}

export interface PiAgentResponse {
  readonly text: string;
  readonly toolCalls: PiToolCall[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
  readonly stopReason: string;
}

// ---------------------------------------------------------------------------
// PiAgent — the main Agent class interface
// ---------------------------------------------------------------------------

export interface PiAgentOptions {
  readonly systemPrompt?: string;
  readonly tools?: AgentTool[];
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly onEvent?: (event: PiAgentEvent) => void;
}

export interface PiAgent {
  prompt(userMessage: string): Promise<PiAgentResponse>;
}

// ---------------------------------------------------------------------------
// Factory — getModel / createAgent
// ---------------------------------------------------------------------------

export interface PiModelHandle {
  createAgent(options: PiAgentOptions): PiAgent;
}

export interface PiAgentCore {
  getModel(
    provider: 'anthropic' | 'ollama' | 'openai',
    modelId: string,
    providerOptions?: Record<string, unknown>,
  ): PiModelHandle;
}
