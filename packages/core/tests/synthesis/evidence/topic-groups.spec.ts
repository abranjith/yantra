import { describe, expect, it } from 'vitest';

import { WinkAnalyzer } from '../../../src/synthesis/analysis/wink-analyzer.js';
import {
  groupClaimsByTopic,
  TOPIC_THRESHOLD,
} from '../../../src/synthesis/evidence/topic-groups.js';
import type { EvidenceClaim } from '../../../src/synthesis/evidence/types.js';

const analyzer = new WinkAnalyzer();

function claim(text: string, salience: number, entityKeys: readonly string[] = []): EvidenceClaim {
  return {
    text,
    kind: 'fact',
    evidenceKinds: ['statement'],
    anchorValues: [],
    entityKeys,
    docIndexes: [0],
    salience,
  };
}

describe('@no-llm synthesis/groupClaimsByTopic', () => {
  it('groups related claims under the first highest-salience parent', () => {
    const claims = [
      claim('Electric vehicle sales fell sharply across the US in 2026.', 10, ['us']),
      claim('US electric vehicle sales declined as incentives expired in 2026.', 8, ['us']),
      claim('Battery factories expanded production in the Southeast.', 6),
    ];

    const groups = groupClaimsByTopic(claims, analyzer, 0.25);

    expect(groups[0]!.parent).toBe(claims[0]);
    expect(groups[0]!.children).toEqual([claims[1]]);
    expect(groups[1]!.parent).toBe(claims[2]);
  });

  it('is deterministic and keeps singleton groups', () => {
    const claims = [
      claim('Charging stations grew in California.', 3),
      claim('Battery prices dropped in Europe.', 2),
    ];

    expect(groupClaimsByTopic(claims, analyzer)).toEqual(groupClaimsByTopic(claims, analyzer));
    expect(groupClaimsByTopic(claims, analyzer, 1)).toHaveLength(2);
  });

  it('uses the exported default threshold', () => {
    expect(TOPIC_THRESHOLD).toBe(0.4);
  });

  it('absorbs a contained duplicate and unions its citations', () => {
    const parent = {
      ...claim(
        'Norway stand one win from an unprecedented semi-final after defeating England.',
        10,
        ['norway'],
      ),
      docIndexes: [0],
    };
    const duplicate = {
      ...claim('Norway stand one win from an unprecedented semi-final.', 8, ['norway']),
      docIndexes: [1],
    };

    const groups = groupClaimsByTopic([parent, duplicate], analyzer, 0.2);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.children).toEqual([]);
    expect(groups[0]!.parent.docIndexes).toEqual([0, 1]);
  });

  it('keeps a similar claim separate when it shares no entity or numeric anchor', () => {
    const groups = groupClaimsByTopic(
      [
        claim('Electric vehicle sales fell sharply across the US market.', 10, ['us']),
        claim('Electric vehicle sales rose sharply across the German market.', 8, ['germany']),
      ],
      analyzer,
      0.2,
    );
    expect(groups).toHaveLength(2);
  });

  it('nests related but distinct claims sharing an entity anchor', () => {
    const groups = groupClaimsByTopic(
      [
        claim('Norway defeated England to reach the tournament quarter-final.', 10, ['norway']),
        claim('Norway coach Ada Hegerberg praised the defensive performance afterward.', 8, [
          'norway',
        ]),
      ],
      analyzer,
      0.1,
    );
    expect(groups[0]!.children).toHaveLength(1);
  });
});
