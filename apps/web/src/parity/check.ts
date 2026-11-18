import type { RunArtifactRegistryEntry, RunEventKind } from '@yantra/protocol/parity';

import type { ParityTarget } from './types.js';

export function parityProblems(
  eventKinds: readonly RunEventKind[],
  artifacts: readonly RunArtifactRegistryEntry[],
  events: Readonly<Record<string, ParityTarget>>,
  mappedArtifacts: Readonly<Record<string, ParityTarget>>,
): string[] {
  const problems: string[] = [];
  const eventSet = new Set(eventKinds);
  const artifactSet = new Set(artifacts.map((item) => item.id));
  for (const kind of eventKinds)
    if (events[kind] === undefined) problems.push(`unmapped event: ${kind}`);
  for (const kind of Object.keys(events))
    if (!eventSet.has(kind as RunEventKind)) problems.push(`stale event: ${kind}`);
  for (const entry of artifacts) {
    const target = mappedArtifacts[entry.id];
    if (target === undefined) problems.push(`unmapped artifact: ${entry.id}`);
    if (entry.exposure !== 'denied' && target?.kind === 'denied')
      problems.push(`public artifact denied: ${entry.id}`);
  }
  for (const id of Object.keys(mappedArtifacts))
    if (!artifactSet.has(id)) problems.push(`stale artifact: ${id}`);
  for (const [key, target] of [...Object.entries(events), ...Object.entries(mappedArtifacts)]) {
    if ((target.kind === 'exemption' || target.kind === 'denied') && target.reason.trim() === '')
      problems.push(`empty reason: ${key}`);
  }
  return problems;
}
