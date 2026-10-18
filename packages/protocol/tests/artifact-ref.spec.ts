import { describe, expect, it } from 'vitest';

import {
  AgentManifestSection,
  ArtifactRef,
  CaptureCapabilityRecord,
  RunHealth,
  SCREENSHOT_ARTIFACT_PATH_PATTERN,
  ToolAuditEntry,
  artifactRefsOf,
} from '../src/index.js';

const SHA = 'ab'.repeat(32);

const ref = (overrides: Record<string, unknown> = {}) => ({
  kind: 'screenshot' as const,
  path: `screenshots/capture-1-${SHA.slice(0, 12)}.png`,
  sha256: SHA,
  mime_type: 'image/png' as const,
  bytes: 2048,
  width: 1280,
  height: 720,
  sent_to_model: false,
  ...overrides,
});

const endEntry = (extra: Record<string, unknown> = {}) => ({
  ts: '2026-10-16T12:00:00.000Z',
  seq: 3,
  run_id: 'run-1',
  session_id: 'session-1',
  call_id: 'call-1',
  tool: 'browser_screenshot',
  phase: 'end' as const,
  input_sanitized: null,
  output_sanitized: { status: 'ok' },
  status: 'ok' as const,
  duration_ms: 120,
  error_code: null,
  confirmation_id: null,
  ...extra,
});

const legacyCapture = {
  path: `screenshots/1-${SHA.slice(0, 12)}.png`,
  sha256: SHA,
  mime_type: 'image/png' as const,
  width: 800,
  height: 600,
  bytes: 4096,
};

const manifest = () => ({
  adapter: 'pi-coding-agent' as const,
  sdk_version: '0.80.6',
  provider: 'anthropic',
  model: 'claude-sonnet',
  thinking: 'medium',
  auth_source: 'managed' as const,
  session_id: 'session-1',
  session_file: 'agent/session-1.jsonl',
  prompt_version: 'agent-v13' as const,
  prompt_hash: 'a'.repeat(64),
  tool_catalog_hash: 'a'.repeat(64),
});

const capability = {
  vision_assist: { available: false, reasons: ['grant_missing', 'model_no_image_input'] },
  deliverable: { available: true, reasons: [] },
};

describe('@no-llm ArtifactRef', () => {
  it('parses a deliverable capture reference and a tiled part', () => {
    expect(ArtifactRef.parse(ref())).toEqual(ref());
    const tile = ref({ path: `screenshots/capture-2-${SHA.slice(0, 12)}-p3.png` });
    expect(ArtifactRef.safeParse(tile).success).toBe(true);
  });

  it('parses a Vision Assist reference without dimensions', () => {
    const vision = ref({ path: `screenshots/4-${SHA.slice(0, 12)}.png`, sent_to_model: true });
    const { width: _w, height: _h, ...noDimensions } = vision;
    expect(ArtifactRef.safeParse(noDimensions).success).toBe(true);
  });

  it.each([
    ['a parent-escaping path', '../x.png'],
    ['an absolute POSIX path', '/tmp/screenshots/capture-1-abababababab.png'],
    ['a Windows drive path', 'C:\\runs\\screenshots\\capture-1-abababababab.png'],
    ['a backslash path', 'screenshots\\capture-1-abababababab.png'],
    ['a path outside the grammar', 'screenshots/x.png'],
    ['an escaping path that ends in the grammar', 'screenshots/../screenshots/1-abababababab.png'],
    ['an uppercase hash', 'screenshots/capture-1-ABABABABABAB.png'],
    ['a non-PNG extension', 'screenshots/capture-1-abababababab.jpg'],
    ['an empty path', ''],
  ])('rejects %s', (_label, path) => {
    expect(ArtifactRef.safeParse(ref({ path })).success).toBe(false);
  });

  it('rejects a non-PNG mime type, an unknown kind, a bad hash, and unknown keys', () => {
    expect(ArtifactRef.safeParse(ref({ mime_type: 'image/jpeg' })).success).toBe(false);
    expect(ArtifactRef.safeParse(ref({ kind: 'video' })).success).toBe(false);
    expect(ArtifactRef.safeParse(ref({ sha256: 'z'.repeat(64) })).success).toBe(false);
    expect(ArtifactRef.safeParse(ref({ data: 'iVBORw0KGgo' })).success).toBe(false);
  });

  it('rejects negative bytes and non-positive dimensions', () => {
    expect(ArtifactRef.safeParse(ref({ bytes: -1 })).success).toBe(false);
    expect(ArtifactRef.safeParse(ref({ width: 0 })).success).toBe(false);
    expect(ArtifactRef.safeParse(ref({ height: 1.5 })).success).toBe(false);
  });

  it('requires sent_to_model', () => {
    const { sent_to_model: _s, ...missing } = ref();
    expect(ArtifactRef.safeParse(missing).success).toBe(false);
  });

  it('exports the capture-file grammar for both producers', () => {
    expect(SCREENSHOT_ARTIFACT_PATH_PATTERN.test('screenshots/0-0123456789ab.png')).toBe(true);
    expect(
      SCREENSHOT_ARTIFACT_PATH_PATTERN.test('screenshots/capture-12-0123456789ab-p6.png'),
    ).toBe(true);
    expect(SCREENSHOT_ARTIFACT_PATH_PATTERN.test('screenshots/capture-1-0123456789ab-p.png')).toBe(
      false,
    );
    expect(SCREENSHOT_ARTIFACT_PATH_PATTERN.test('captures/cap-1.txt')).toBe(false);
  });
});

describe('@no-llm tool-audit artifacts and the legacy normalizer', () => {
  it('parses a FEAT-036-era line with captures and normalizes it as sent to the model', () => {
    const entry = ToolAuditEntry.parse(endEntry({ captures: [legacyCapture] }));

    expect(entry.artifacts).toBeUndefined();
    expect(artifactRefsOf(entry)).toEqual([
      {
        kind: 'screenshot',
        path: legacyCapture.path,
        sha256: SHA,
        mime_type: 'image/png',
        bytes: 4096,
        width: 800,
        height: 600,
        sent_to_model: true,
      },
    ]);
    // The normalized form satisfies the new schema too.
    expect(ArtifactRef.safeParse(artifactRefsOf(entry)[0]).success).toBe(true);
  });

  it('parses a line with artifacts and returns them unchanged', () => {
    const artifacts = [ref(), ref({ path: `screenshots/capture-1-${SHA.slice(0, 12)}-p2.png` })];
    const entry = ToolAuditEntry.parse(endEntry({ tool: 'browser_capture', artifacts }));

    expect(artifactRefsOf(entry)).toEqual(artifacts);
  });

  it('prefers artifacts when a line carries both', () => {
    const entry = ToolAuditEntry.parse(
      endEntry({ captures: [legacyCapture], artifacts: [ref({ sent_to_model: true })] }),
    );

    expect(artifactRefsOf(entry)).toEqual([ref({ sent_to_model: true })]);
  });

  it('returns no refs for an entry with neither field', () => {
    expect(artifactRefsOf(ToolAuditEntry.parse(endEntry()))).toEqual([]);
    expect(artifactRefsOf(ToolAuditEntry.parse(endEntry({ artifacts: [] })))).toEqual([]);
  });

  it('rejects an artifact with an escaping path on a tool-audit line', () => {
    const result = ToolAuditEntry.safeParse(endEntry({ artifacts: [ref({ path: '../x.png' })] }));
    expect(result.success).toBe(false);
  });
});

describe('@no-llm capture capability records', () => {
  it('parses an available and an unavailable decision', () => {
    expect(CaptureCapabilityRecord.parse(capability)).toEqual(capability);
    const suppressed = {
      vision_assist: { available: false, reasons: ['suppressed_by_flag'] },
      deliverable: { available: false, reasons: ['suppressed_by_flag', 'no_browser'] },
    };
    expect(CaptureCapabilityRecord.safeParse(suppressed).success).toBe(true);
  });

  it('rejects available with a reason and unavailable with none', () => {
    const availableWithReason = {
      ...capability,
      deliverable: { available: true, reasons: ['no_browser'] },
    };
    const unavailableWithout = {
      ...capability,
      vision_assist: { available: false, reasons: [] },
    };

    expect(CaptureCapabilityRecord.safeParse(availableWithReason).success).toBe(false);
    expect(CaptureCapabilityRecord.safeParse(unavailableWithout).success).toBe(false);
  });

  it('rejects a reason from the other capability and an unknown reason', () => {
    const crossed = {
      ...capability,
      deliverable: { available: false, reasons: ['grant_missing'] },
    };
    const unknown = {
      ...capability,
      vision_assist: { available: false, reasons: ['model_text_only'] },
    };

    expect(CaptureCapabilityRecord.safeParse(crossed).success).toBe(false);
    expect(CaptureCapabilityRecord.safeParse(unknown).success).toBe(false);
  });

  it('is optional on the manifest agent section and validated when present', () => {
    expect(AgentManifestSection.safeParse(manifest()).success).toBe(true);
    expect(AgentManifestSection.safeParse({ ...manifest(), capture: capability }).success).toBe(
      true,
    );
    const invalid = { ...capability, deliverable: { available: false, reasons: [] } };
    expect(AgentManifestSection.safeParse({ ...manifest(), capture: invalid }).success).toBe(false);
  });

  it('is optional on run-health and carries counts only', () => {
    const health = {
      schema_version: 1,
      run_id: 'run-1',
      searches: { total: 0, ok: 0, failed_by_code: {}, providers: [] },
      fetches: {
        total: 0,
        by_mode: { http: 0, browser: 0 },
        repeat_fetches: 0,
        failed_by_code: {},
      },
      source_failures: { fetch: 0, extract: 0, blocked: 0, budget: 0, policy: 0 },
      browser: { launches: 1 },
      budgets: {
        navigations_used: 1,
        navigations_limit: 30,
        hosts_used: 1,
        hosts_limit: 20,
        exhausted: [],
      },
      tool_failures: { total: 0, by_code: {} },
      notices: 0,
    };
    const block = {
      ...capability,
      deliverable_calls: 1,
      deliverable_files: 3,
      deliverable_bytes: 90_000,
    };

    expect(RunHealth.safeParse(health).success).toBe(true);
    expect(RunHealth.safeParse({ ...health, capture: block }).success).toBe(true);
    expect(
      RunHealth.safeParse({ ...health, capture: { ...block, deliverable_files: -1 } }).success,
    ).toBe(false);
    expect(
      RunHealth.safeParse({ ...health, capture: { ...block, path: 'screenshots/x.png' } }).success,
    ).toBe(false);
  });
});
