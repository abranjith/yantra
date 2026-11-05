/**
 * `@yantra/ui` — Drshya, Yantra's design system.
 *
 * Browser code only: this package may import `@yantra/protocol` for types, and
 * never `@yantra/core`, `@yantra/agent` or a Node built-in (plan_ui §8
 * "Dependency direction"; enforced by `eslint.config.js`).
 */

/** The package's own name, so the build always has an entry point. */
export const DRSHYA_PACKAGE = '@yantra/ui' as const;
