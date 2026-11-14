/**
 * A controllable `window.matchMedia` for jsdom, which ships none.
 *
 * Tests declare which media queries match with {@link setMatchMedia}; every
 * query not listed reports `matches: false`. Listeners registered on a query
 * list are notified when a later `setMatchMedia` call flips that query, so
 * code that subscribes to `prefers-color-scheme` or `prefers-reduced-motion`
 * can be exercised end to end.
 */

type MediaListener = (event: MediaQueryListEvent) => void;

interface FakeMediaQueryList {
  readonly list: MediaQueryList;
  readonly listeners: Set<MediaListener>;
}

let matching: ReadonlyMap<string, boolean> = new Map();
const lists = new Map<string, FakeMediaQueryList>();

/** Strips the outer parentheses and whitespace so `(a: b)` and `a: b` agree. */
function normalizeQuery(query: string): string {
  return query
    .trim()
    .replace(/^\((.*)\)$/u, '$1')
    .trim();
}

function matches(query: string): boolean {
  return matching.get(normalizeQuery(query)) ?? false;
}

function createList(query: string): FakeMediaQueryList {
  const listeners = new Set<MediaListener>();
  const list = {
    get matches() {
      return matches(query);
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: MediaListener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: MediaListener) => {
      listeners.delete(listener);
    },
    addListener: (listener: MediaListener) => {
      listeners.add(listener);
    },
    removeListener: (listener: MediaListener) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
  return { list, listeners };
}

/**
 * Sets which media queries match, replacing the previous set, and notifies the
 * listeners of every query whose result changed.
 *
 * @example setMatchMedia({ 'prefers-color-scheme: dark': true })
 */
export function setMatchMedia(next: Readonly<Record<string, boolean>>): void {
  const before = new Map([...lists.keys()].map((query) => [query, matches(query)]));
  matching = new Map(Object.entries(next).map(([query, value]) => [normalizeQuery(query), value]));
  for (const [query, entry] of lists) {
    const now = matches(query);
    if (before.get(query) === now) {
      continue;
    }
    const event = { matches: now, media: query } as MediaQueryListEvent;
    for (const listener of entry.listeners) {
      listener(event);
    }
  }
}

/** Installs the fake on `window`; called once from the setup file. */
export function installMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => {
      let entry = lists.get(query);
      if (entry === undefined) {
        entry = createList(query);
        lists.set(query, entry);
      }
      return entry.list;
    },
  });
}

/** Resets every query to non-matching and forgets registered listeners. */
export function resetMatchMedia(): void {
  matching = new Map();
  lists.clear();
}
