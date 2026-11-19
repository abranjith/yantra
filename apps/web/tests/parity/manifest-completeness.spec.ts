import { COMMAND_REGISTRY, expandOptions } from '@yantra/protocol/commands';
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
  it('reserves only the remaining FEAT-071 paths', () => {
    expect(
      Object.entries(PARITY_MANIFEST.commands)
        .filter(([, target]) => target.kind === 'reserved')
        .map(([path]) => path)
        .sort(),
    ).toEqual(['doctor', 'init']);
  });
});
