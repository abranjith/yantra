/**
 * Minimal helpers for asserting on the generated stylesheet: pull out the body
 * of one block by its exact selector line, and its declarations.
 */

/** The text between `<selector> {` and its matching `}`; throws if absent. */
export function blockBody(css: string, selector: string): string {
  const opener = `${selector} {`;
  const start = css.indexOf(opener);
  if (start === -1) {
    throw new Error(`no block for ${selector}`);
  }
  let depth = 0;
  for (let index = start + opener.length - 1; index < css.length; index += 1) {
    const char = css[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return css.slice(start + opener.length, index);
      }
    }
  }
  throw new Error(`unterminated block for ${selector}`);
}

/** Trimmed `name: value;` lines of a block body, nested blocks included. */
export function declarations(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith(';'));
}

/** The custom-property names declared in a block body. */
export function propertyNames(body: string): string[] {
  return declarations(body).map((line) => line.slice(0, line.indexOf(':')));
}
