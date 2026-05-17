// @no-llm
import { describe, it, expect } from 'vitest';

import {
  evaluateOutputs,
  redactOutputsForDisk,
} from '../../../src/workflow/replay/output-evaluator.js';
import type { OutputBinding } from '../../../src/workflow/replay/types.js';

describe('evaluateOutputs', () => {
  it('evaluates a simple JSONata expression', async () => {
    const bindings: OutputBinding[] = [
      { name: 'title', expression: 'capture.pageTitle', retention: 'persisted' },
    ];
    const result = await evaluateOutputs(bindings, {
      captures: { pageTitle: 'Home Page' },
      params: {},
    });
    expect(result.persisted['title']).toBe('Home Page');
    expect(result.errors).toHaveLength(0);
  });

  it('puts transient bindings in transient not persisted', async () => {
    const bindings: OutputBinding[] = [
      { name: 'token', expression: 'capture.rawToken', retention: 'transient' },
    ];
    const result = await evaluateOutputs(bindings, {
      captures: { rawToken: 'abc123' },
      params: {},
    });
    expect(result.transient['token']).toBe('abc123');
    expect(result.persisted['token']).toBeUndefined();
  });

  it('records non-fatal error for invalid expression', async () => {
    const bindings: OutputBinding[] = [
      { name: 'bad', expression: '$invalid(@@@@', retention: 'persisted' },
    ];
    const result = await evaluateOutputs(bindings, { captures: {}, params: {} });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.name).toBe('bad');
  });

  it('can access params in scope', async () => {
    const bindings: OutputBinding[] = [
      { name: 'month', expression: 'param.month', retention: 'persisted' },
    ];
    const result = await evaluateOutputs(bindings, {
      captures: {},
      params: { month: '2026-04' },
    });
    expect(result.persisted['month']).toBe('2026-04');
  });

  it('returns empty outputs for no bindings', async () => {
    const result = await evaluateOutputs([], { captures: {}, params: {} });
    expect(result.persisted).toEqual({});
    expect(result.transient).toEqual({});
    expect(result.errors).toEqual([]);
  });

  it('handles expression returning undefined (skipped)', async () => {
    const bindings: OutputBinding[] = [
      { name: 'missing', expression: 'capture.noSuchField', retention: 'persisted' },
    ];
    const result = await evaluateOutputs(bindings, { captures: {}, params: {} });
    expect(result.persisted['missing']).toBeUndefined();
    expect(result.errors).toHaveLength(0);
  });

  it('records error when result exceeds 100 KB cap', async () => {
    // Build a large string > 100KB
    const big = 'x'.repeat(200_000);
    const bindings: OutputBinding[] = [
      { name: 'big', expression: 'capture.big', retention: 'persisted' },
    ];
    const result = await evaluateOutputs(bindings, {
      captures: { big },
      params: {},
    });
    expect(result.errors[0]?.name).toBe('big');
    expect(result.errors[0]?.error).toContain('exceeds');
  });
});

describe('redactOutputsForDisk', () => {
  it('passes through innocuous values unchanged', () => {
    const result = redactOutputsForDisk({ title: 'Home Page', count: 5 });
    expect(result['title']).toBe('Home Page');
    expect(result['count']).toBe(5);
  });

  it('redacts OpenAI-shaped secrets in string values', () => {
    const result = redactOutputsForDisk({
      token: 'sk-abcdefghijklmnopqrstuvwxyz1234567890',
    });
    expect(result['token']).toBe('<redacted:secret-shape>');
  });

  it('redacts GitHub-shaped secrets', () => {
    const result = redactOutputsForDisk({
      token: 'ghp_abcdefghijklmnopqrstuvwxyz1234567',
    });
    expect(result['token']).toBe('<redacted:secret-shape>');
  });

  it('redacts nested values', () => {
    const result = redactOutputsForDisk({
      outer: { inner: 'sk-abcdefghijklmnopqrstuvwxyz1234567890' },
    });
    const outer = result['outer'] as Record<string, unknown>;
    expect(outer['inner']).toBe('<redacted:secret-shape>');
  });

  it('handles array values', () => {
    const result = redactOutputsForDisk({
      list: ['safe', 'sk-abcdefghijklmnopqrstuvwxyz1234567890'],
    });
    const list = result['list'] as unknown[];
    expect(list[0]).toBe('safe');
    expect(list[1]).toBe('<redacted:secret-shape>');
  });
});
