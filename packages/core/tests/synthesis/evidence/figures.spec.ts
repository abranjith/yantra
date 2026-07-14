import { describe, expect, it } from 'vitest';

import { deriveKeyFigures } from '../../../src/synthesis/evidence/figures.js';

describe('@no-llm deriveKeyFigures', () => {
  it('reduces representative World Cup figures to compact rows', () => {
    const rows = deriveKeyFigures([
      {
        text: 'Total attendance reached 3,605,357 spectators across the tournament.',
        citations: [1],
      },
      { text: 'The expanded field includes 48 teams in the final tournament.', citations: [2] },
      { text: 'Matches will be staged across 16 host cities in three countries.', citations: [3] },
      { text: 'The opening match is scheduled for June 11, 2026, in Mexico City.', citations: [4] },
    ]);
    expect(rows.map((row) => row.figure)).toEqual([
      '3,605,357 spectators',
      '48 teams',
      '16 host cities',
      'June 11, 2026',
    ]);
    expect(rows.every((row) => row.context.length >= 12 && row.context.length <= 90)).toBe(true);
  });

  it('prefers money over percentages and quantities in a multi-figure claim', () => {
    const [row] = deriveKeyFigures([
      {
        text: 'Revenue reached $2 billion after growing 20 percent across 48 markets.',
        citations: [1],
      },
    ]);
    expect(row?.figure).toBe('$2 billion');
  });

  it('drops non-reducible contexts and deduplicates repeated rows', () => {
    const claim = { text: 'Attendance reached 48 teams in the final tournament.', citations: [1] };
    const rows = deriveKeyFigures([
      claim,
      { ...claim, citations: [2] },
      { text: 'It had 2.', citations: [1] },
    ]);
    expect(rows).toHaveLength(1);
  });
});
