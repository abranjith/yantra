// Must lint clean: semantic utilities, a custom-property inline style, and an
// engine ref string that only looks like a hex color.
export const clean = (
  <div
    className="bg-surface text-ink-2 border-rule hover:bg-sunken"
    style={{ '--progress': '40%' }}
  >
    {'#07'}
  </div>
);
