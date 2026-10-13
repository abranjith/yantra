import { describe, expect, it } from 'vitest';

import { DefaultSanitizer } from '../../src/sanitizer/index.js';
import { stripFormValues } from '../../src/sanitizer/strippers.js';

describe('@no-llm form stripping preserves unchanged URL payloads', () => {
  it('keeps multi-parameter URLs byte-identical in JSON when no form exists', () => {
    const payload = ['https://listings.test/results?condition=new&trim=Summit&drivetrain=AWD'];
    expect(stripFormValues(JSON.stringify(payload))).toEqual({
      text: JSON.stringify(payload),
      hits: 0,
    });
    expect(new DefaultSanitizer().sanitize(payload, 'public').text).toBe(JSON.stringify(payload));
  });
  it('still strips actual form values and editable contents', () => {
    const result = stripFormValues(
      '<input value="canary-form"><textarea>canary-area</textarea><div contenteditable>canary-edit</div>',
    );
    expect(result.hits).toBe(3);
    expect(result.text).not.toContain('canary-');
  });
});
