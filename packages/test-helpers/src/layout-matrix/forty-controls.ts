import type { MatrixPage } from './types.js';

/** Forty synthetic controls with explicit identity and no suggestion behavior. */
export const fortyControls: MatrixPage = {
  id: 'forty-controls',
  pattern: 'A long form filled in bounded batches',
  controls: Array.from({ length: 40 }, (_, i) => ({
    key: `f${i}`,
    role:
      i >= 27 && i < 31
        ? 'combobox'
        : i >= 31 && i < 34
          ? 'checkbox'
          : i >= 34 && i < 37
            ? 'radio'
            : 'textbox',
    expect: { kind: 'label' as const, query: `Field ${i}`, origin: 'explicit' as const },
  })),
  html: () => `<!doctype html><html><body><form onsubmit="window.__submits++;return false">
    ${Array.from({ length: 40 }, (_, i) => {
      const attrs = `id="f${i}" data-fixture-key="f${i}"`;
      let control: string;
      if (i >= 27 && i < 31)
        control = `<select ${attrs}><option value="">Choose</option><option>Blue</option></select>`;
      else if (i >= 31 && i < 34) control = `<input ${attrs} type="checkbox">`;
      else if (i >= 34 && i < 37) control = `<input ${attrs} type="radio" name="choice">`;
      else if (i < 26 && i % 6 === 5) control = `<textarea ${attrs}></textarea>`;
      else {
        const type =
          i === 15
            ? 'number'
            : i < 26
              ? ['text', 'email', 'tel', 'url', 'number', 'text'][i % 6]
              : 'text';
        control = `<input ${attrs} type="${type}"${i === 15 ? ' max="10" step="1"' : ''}>`;
      }
      return `<div><label for="f${i}">Field ${i}</label>${control}</div>`;
    }).join('')}
    <button type="submit">Submit</button></form><script>
    window.__submits = 0;
    document.getElementById('f15').addEventListener('input', function () {
      if (!this.validity.valid) this.value = '';
    });
    document.getElementById('f26').addEventListener('input', function () {
      const digits = this.value.replace(/\\D/g, '').slice(0,10);
      if (digits.length === 10) this.value = '(' + digits.slice(0,3) + ') ' + digits.slice(3,6) + '-' + digits.slice(6);
    });
    </script></body></html>`,
};

/** Intended value by physical control; radio siblings are driven as one census unit. */
export function fortyControlValue(index: number): string {
  if (index >= 27 && index < 31) return 'Blue';
  if (index >= 31 && index < 37) return 'checked';
  if (index === 26) return '5551234567';
  if (index === 15) return '8';
  if (index < 26) {
    if (index % 6 === 1) return 'p@x.test';
    if (index % 6 === 3) return 'https://x.test';
    if (index % 6 === 4) return '8';
  }
  return `v${index}`;
}
