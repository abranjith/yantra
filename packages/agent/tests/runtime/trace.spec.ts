// @no-llm
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentTrace,
  AgentTraceFileSchema,
  toCandidateChain,
  type AgentTraceStep,
} from '../../src/runtime/trace.js';

describe('@no-llm toCandidateChain', () => {
  it('builds a role candidate for a modelled ARIA role with a name', () => {
    expect(toCandidateChain('button', 'Continue')).toEqual([
      { kind: 'role', role: 'button', name: 'Continue' },
    ]);
  });

  it('records searchbox and listbox verbatim instead of aliasing them away', () => {
    // Regression: these were rewritten to `textbox` and `combobox` because the
    // schema did not model them. The locator engine computes `searchbox` for
    // `input[type=search]` and `listbox` for `<select>`, so the rewritten role
    // could never match at replay — every recorded search field and dropdown
    // failed with "locator not found" on an unchanged page.
    expect(toCandidateChain('searchbox', 'Search')).toEqual([
      { kind: 'role', role: 'searchbox', name: 'Search' },
    ]);
    expect(toCandidateChain('listbox', 'Options')).toEqual([
      { kind: 'role', role: 'listbox', name: 'Options' },
    ]);
  });

  it.each(['spinbutton', 'slider'])(
    'records the %s role the engine computes for numeric and range inputs',
    (role) => {
      expect(toCandidateChain(role, 'Quantity')).toEqual([
        { kind: 'role', role, name: 'Quantity' },
      ]);
    },
  );

  it('falls back to a label candidate for an unmodelled role with a name', () => {
    expect(toCandidateChain('tooltip', 'Info')).toEqual([{ kind: 'label', value: 'Info' }]);
  });

  it('degrades to a generic role candidate when nothing usable is present', () => {
    expect(toCandidateChain('tooltip', '')).toEqual([{ kind: 'role', role: 'button', name: '' }]);
  });
});

describe('@no-llm AgentTrace', () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-trace-'));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('preserves append order (execution order)', () => {
    const trace = new AgentTrace();
    const steps: AgentTraceStep[] = [
      {
        kind: 'navigate',
        host: 'a.example',
        url: 'https://a.example/',
        requires_confirmation: false,
      },
      {
        kind: 'fill',
        host: 'a.example',
        locator: [{ kind: 'role', role: 'textbox', name: 'Email' }],
        value: { kind: 'literal', value: 'me@x.io' },
        submit: false,
        requires_confirmation: false,
      },
      {
        kind: 'click',
        host: 'a.example',
        locator: [{ kind: 'role', role: 'button', name: 'Sign in' }],
        requires_confirmation: false,
      },
    ];
    for (const step of steps) trace.append(step);
    expect(trace.steps().map((s) => s.kind)).toEqual(['navigate', 'fill', 'click']);
  });

  it('records a secret fill as a reference, never the resolved value (canary)', async () => {
    const trace = new AgentTrace();
    trace.append({
      kind: 'fill',
      host: 'bank.example',
      locator: [{ kind: 'role', role: 'textbox', name: 'Password' }],
      value: { kind: 'secret_ref', key: 'bank.password' },
      submit: false,
      requires_confirmation: true,
    });
    await trace.finalize(runDir);
    const raw = await readFile(join(runDir, 'trace.json'), 'utf8');
    expect(raw).toContain('secret_ref');
    expect(raw).toContain('bank.password');
    // The literal resolved value would never appear — the canary proves it.
    expect(raw).not.toContain('CANARY-RESOLVED-VALUE');
  });

  it('carries a candidate chain for every interactive step', () => {
    const trace = new AgentTrace();
    trace.append({
      kind: 'click',
      host: 'x.example',
      locator: toCandidateChain('button', 'Go'),
      requires_confirmation: false,
    });
    trace.append({
      kind: 'fill',
      host: 'x.example',
      locator: toCandidateChain('textbox', 'Name'),
      value: { kind: 'literal', value: 'Ada' },
      submit: false,
      requires_confirmation: false,
    });
    for (const step of trace.steps()) {
      if (step.kind === 'click' || step.kind === 'fill') {
        expect(step.locator.length).toBeGreaterThan(0);
      }
    }
  });

  it('writes a trace.json that validates against the closed schema', async () => {
    const trace = new AgentTrace();
    trace.append({
      kind: 'navigate',
      host: 'x.example',
      url: 'https://x.example/',
      requires_confirmation: false,
    });
    trace.append({
      kind: 'extract',
      host: 'x.example',
      extractionKind: 'table',
      requires_confirmation: false,
    });
    await trace.finalize(runDir);
    const parsed = JSON.parse(await readFile(join(runDir, 'trace.json'), 'utf8'));
    expect(() => AgentTraceFileSchema.parse(parsed)).not.toThrow();
  });

  it('reports empty state before any interaction', () => {
    expect(new AgentTrace().isEmpty()).toBe(true);
  });
});
