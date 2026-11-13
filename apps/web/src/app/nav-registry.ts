/**
 * The app's navigation entries (FEAT-065 TASK-011). A feature registers its
 * entry when it registers its route, so the top bar never shows a dead link.
 * FEAT-065 registers only Home.
 */

/** One navigation entry. */
export interface NavEntry {
  /** The route path it links to. */
  readonly path: string;
  /** The visible label, in the CLI's words. */
  readonly label: string;
}

/** An ordered, append-only list of entries; registering a path twice is a bug. */
export class NavRegistry {
  private readonly items: NavEntry[] = [];

  public register(entry: NavEntry): void {
    if (this.items.some((item) => item.path === entry.path)) {
      throw new Error(`Navigation entry ${entry.path} is already registered.`);
    }
    this.items.push(entry);
  }

  public entries(): readonly NavEntry[] {
    return this.items;
  }
}

/** The app-wide registry. */
export const navRegistry = new NavRegistry();

navRegistry.register({ path: '/', label: 'Home' });
