import { COMMAND_REGISTRY, expandOptions, isKnownDeadOption } from '@yantra/protocol/commands';
import { RUN_ARTIFACT_REGISTRY, RUN_EVENT_KINDS } from '@yantra/protocol/parity';
import { describe, expect, it } from 'vitest';

import { parityProblems } from '../../src/parity/check.js';
import { PARITY_MANIFEST } from '../../src/parity/manifest.js';
import { assertDefinitions } from '../../src/surfaces/definitions.js';

describe('@no-llm parity manifest completeness', () => {
  it('covers every event, artifact, command and option bidirectionally', () => {
    expect(
      parityProblems(
        RUN_EVENT_KINDS,
        RUN_ARTIFACT_REGISTRY,
        PARITY_MANIFEST.events,
        PARITY_MANIFEST.artifacts,
      ),
    ).toEqual([]);
    const commands = COMMAND_REGISTRY.commands
      .filter((e) => e.kind === 'leaf')
      .map((e) => e.path.join(' '))
      .sort();
    expect(Object.keys(PARITY_MANIFEST.commands).sort()).toEqual(commands);
    const options = COMMAND_REGISTRY.commands
      .flatMap((e) =>
        e.kind === 'leaf'
          ? expandOptions(e, COMMAND_REGISTRY.option_groups).map(
              (o) => `${e.path.join(' ')} ${o.long}`,
            )
          : [],
      )
      .sort();
    expect(Object.keys(PARITY_MANIFEST.options).sort()).toEqual(options);
    expect(() => assertDefinitions()).not.toThrow();
  });
  it('names a synthetic missing kind', () => {
    expect(
      parityProblems(
        [...RUN_EVENT_KINDS, 'fake' as never],
        RUN_ARTIFACT_REGISTRY,
        PARITY_MANIFEST.events,
        PARITY_MANIFEST.artifacts,
      ),
    ).toContain('unmapped event: fake');
  });
  it('has no remaining reserved FEAT-071 paths and maps init, doctor, and secret', () => {
    expect(
      Object.entries(PARITY_MANIFEST.commands)
        .filter(([, target]) => target.kind === 'reserved')
        .map(([path]) => path)
        .sort(),
    ).toEqual([]);
    expect(PARITY_MANIFEST.commands.init).toEqual({
      kind: 'adapter',
      adapter: 'init-onboarding',
      surface: 'onboarding',
    });
    expect(PARITY_MANIFEST.commands.doctor).toEqual({ kind: 'surface', surface: 'health' });
    expect(PARITY_MANIFEST.commands['secret set']).toEqual({
      kind: 'surface',
      surface: 'credentials',
    });
    expect(PARITY_MANIFEST.commands['secret list']).toEqual({
      kind: 'surface',
      surface: 'credentials',
    });
    expect(PARITY_MANIFEST.commands['secret rm']).toEqual({
      kind: 'surface',
      surface: 'credentials',
    });
    expect(PARITY_MANIFEST.options['init --reset']).toEqual({
      kind: 'adapter_action',
      label: 'Run setup again',
    });
    expect(PARITY_MANIFEST.options['init --provider']?.kind).toBe('exemption');
    expect(PARITY_MANIFEST.options['init --yes']?.kind).toBe('exemption');
    expect(PARITY_MANIFEST.options['init --json']?.kind).toBe('exemption');
    expect(PARITY_MANIFEST.options['doctor --refresh']).toEqual({
      kind: 'adapter_action',
      label: 'Re-run checks',
    });
    expect(PARITY_MANIFEST.options['doctor --agent-smoke']).toEqual({
      kind: 'adapter_action',
      label: 'Provider smoke test',
    });
    expect(PARITY_MANIFEST.options['doctor --json']?.kind).toBe('exemption');
    for (const id of ['init', 'doctor', 'secret.set', 'secret.list', 'secret.rm']) {
      const entry = COMMAND_REGISTRY.commands.find((c) => c.id === id);
      expect(entry).toBeDefined();
      if (entry?.kind === 'leaf') {
        for (const opt of expandOptions(entry, COMMAND_REGISTRY.option_groups)) {
          expect(isKnownDeadOption(id, opt.long)).toBe(false);
        }
      }
    }
  });
});
