import { z } from 'zod';

const RelativeSessionFile = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.split(/[\\/]/).includes('..'),
    'Session file must be a relative path contained by the run directory.',
  )
  .describe('Relative path from the run directory to the provider session JSONL.');

/** Stable provider-session metadata persisted inside a run manifest. */
export const AgentManifestSection = z
  .object({
    adapter: z.literal('pi-coding-agent').describe('Agent adapter used for this run.'),
    sdk_version: z.string().min(1).describe('Installed provider SDK version resolved at runtime.'),
    provider: z.string().min(1).describe('Effective model provider identifier.'),
    model: z.string().min(1).describe('Effective provider-scoped model identifier.'),
    thinking: z.string().min(1).describe('Effective model thinking or reasoning level.'),
    auth_source: z
      .enum(['managed', 'runtime-key', 'environment'])
      .describe('Credential source used to open the session; never credential material.'),
    session_id: z.string().min(1).describe('Provider-assigned session identifier.'),
    session_file: RelativeSessionFile,
    // Every version ever shipped stays listed so previously persisted run
    // manifests keep validating (run-artifact compatibility).
    prompt_version: z
      .enum(['agent-v1', 'agent-v2', 'agent-v3', 'agent-v4', 'agent-v5', 'agent-v6', 'agent-v7'])
      .describe('Version of the authoritative agent prompt.'),
    prompt_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('SHA-256 of the exact system prompt.'),
    tool_catalog_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('SHA-256 of the canonical tool catalog serialization.'),
  })
  .strict()
  .describe('Stable agent metadata embedded in manifest.json for one run-local session.');

export type AgentManifestSection = z.infer<typeof AgentManifestSection>;
