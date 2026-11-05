/**
 * `CSS.escape` for jsdom, which ships no `CSS` global. React Aria's
 * collections (Tabs, Table) call it to build selectors. This is the CSSOM
 * "serialize an identifier" algorithm.
 */
export function cssEscape(value: string): string {
  const string = String(value);
  const length = string.length;
  const first = string.charCodeAt(0);
  let result = '';
  for (let index = 0; index < length; index += 1) {
    const code = string.charCodeAt(index);
    if (code === 0x0000) {
      result += '�';
    } else if (
      (code >= 0x0001 && code <= 0x001f) ||
      code === 0x007f ||
      (index === 0 && code >= 0x0030 && code <= 0x0039) ||
      (index === 1 && code >= 0x0030 && code <= 0x0039 && first === 0x002d)
    ) {
      result += `\\${code.toString(16)} `;
    } else if (index === 0 && length === 1 && code === 0x002d) {
      result += `\\${string.charAt(index)}`;
    } else if (
      code >= 0x0080 ||
      code === 0x002d ||
      code === 0x005f ||
      (code >= 0x0030 && code <= 0x0039) ||
      (code >= 0x0041 && code <= 0x005a) ||
      (code >= 0x0061 && code <= 0x007a)
    ) {
      result += string.charAt(index);
    } else {
      result += `\\${string.charAt(index)}`;
    }
  }
  return result;
}

/** Installs `CSS.escape` when the environment lacks it. */
export function installCssEscape(): void {
  const target = globalThis as { CSS?: { escape?: (value: string) => string } };
  if (typeof target.CSS?.escape === 'function') {
    return;
  }
  target.CSS = { ...(target.CSS ?? {}), escape: cssEscape };
}
