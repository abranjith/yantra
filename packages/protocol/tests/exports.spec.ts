import { describe, expect, it } from 'vitest';

import * as Protocol from '../src/index.js';

describe('@no-llm protocol exports', () => {
  it('exposes core protocol symbols', () => {
    expect(Protocol).toHaveProperty('TaskRequest');
    expect(Protocol).toHaveProperty('PlanSchema');
    expect(Protocol).toHaveProperty('Step');
    expect(Protocol).toHaveProperty('TaskEvent');
    expect(Protocol).toHaveProperty('validateSemantics');
    expect(Protocol).toHaveProperty('emitJsonSchemas');
  });
});
