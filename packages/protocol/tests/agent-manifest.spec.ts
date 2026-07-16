import { describe, expect, it } from 'vitest';

import { AgentManifestSection, ToolAuditEntry } from '../src/index.js';

const HASH = 'a'.repeat(64);

const makeManifest = () => ({
  adapter: 'pi-coding-agent' as const,
  sdk_version: '0.80.6',
  provider: 'anthropic',
  model: 'claude-sonnet',
  thinking: 'medium',
  auth_source: 'managed' as const,
  session_id: 'session-1',
  session_file: 'agent/session-1.jsonl',
  prompt_version: 'agent-v1' as const,
  prompt_hash: HASH,
  tool_catalog_hash: HASH,
});

const makeAuditEntry = () => ({
  ts: '2026-07-14T12:00:00.000Z',
  seq: 0,
  run_id: 'run-1',
  session_id: 'session-1',
  call_id: 'call-1',
  tool: 'web_search',
  phase: 'start' as const,
  input_sanitized: { query: 'safe' },
  output_sanitized: null,
  status: null,
  duration_ms: null,
  error_code: null,
  confirmation_id: null,
});

describe('@no-llm agent persistence protocol schemas', () => {
  it('round-trips valid manifest and tool audit entries', () => {
    expect(AgentManifestSection.parse(makeManifest())).toEqual(makeManifest());
    expect(ToolAuditEntry.parse(makeAuditEntry())).toEqual(makeAuditEntry());
  });

  it('rejects absolute and escaping session paths on every platform', () => {
    for (const session_file of [
      '/tmp/session.jsonl',
      'C:\\runs\\session.jsonl',
      '\\\\server\\share\\session.jsonl',
      'agent/../session.jsonl',
    ]) {
      expect(AgentManifestSection.safeParse({ ...makeManifest(), session_file }).success).toBe(
        false,
      );
    }
  });

  it('rejects invalid phases, timestamps, and sequence numbers', () => {
    expect(ToolAuditEntry.safeParse({ ...makeAuditEntry(), phase: 'progress' }).success).toBe(
      false,
    );
    expect(ToolAuditEntry.safeParse({ ...makeAuditEntry(), ts: 'yesterday' }).success).toBe(false);
    expect(
      ToolAuditEntry.safeParse({ ...makeAuditEntry(), ts: '2026-07-14T12:00:00+01:00' }).success,
    ).toBe(false);
    expect(ToolAuditEntry.safeParse({ ...makeAuditEntry(), seq: -1 }).success).toBe(false);
  });

  it('rejects unknown keys because persisted schemas are closed', () => {
    expect(AgentManifestSection.safeParse({ ...makeManifest(), credential: 'never' }).success).toBe(
      false,
    );
    expect(ToolAuditEntry.safeParse({ ...makeAuditEntry(), raw_input: 'never' }).success).toBe(
      false,
    );
  });
});
