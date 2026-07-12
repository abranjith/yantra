import { describe, expect, it } from 'vitest';

import { WinkAnalyzer } from '../../../src/synthesis/analysis/wink-analyzer.js';
import {
  groupClaimsByTopic,
  TOPIC_THRESHOLD,
} from '../../../src/synthesis/evidence/topic-groups.js';
import type { EvidenceClaim } from '../../../src/synthesis/evidence/types.js';

const analyzer = new WinkAnalyzer();

function claim(text: string, salience: number): EvidenceClaim {
  return {
    text,
    kind: 'fact',
    evidenceKinds: ['statement'],
    anchorValues: [],
    docIndexes: [0],
    salience,
  };
}

describe('@no-llm synthesis/groupClaimsByTopic', () => {
  it('groups related claims under the first highest-salience parent', () => {
    const claims = [
      claim('Electric vehicle sales fell sharply across the US in 2026.', 10),
      claim('US electric vehicle sales declined as incentives expired in 2026.', 8),
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
});
