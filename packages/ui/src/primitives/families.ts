/**
 * Primitive families: a primitive can span several exports (`Tabs`,
 * `TabList`, `Tab`, `TabPanel`). The gallery has one entry per family, and the
 * completeness test checks both directions: every export belongs to exactly
 * one family, and every family has a gallery entry.
 */
export const PRIMITIVE_FAMILIES = {
  Button: ['Button'],
  Link: ['Link'],
  Tabs: ['Tabs', 'TabList', 'Tab', 'TabPanel'],
  Tooltip: ['TooltipTrigger', 'Tooltip'],
  Disclosure: ['Disclosure', 'DisclosureTrigger', 'DisclosurePanel'],
  Toast: ['ToastProvider'],
  Table: ['Table'],
  TextField: ['TextField'],
  NumberField: ['NumberField'],
  Checkbox: ['Checkbox'],
  Switch: ['Switch'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type PrimitiveFamily = keyof typeof PRIMITIVE_FAMILIES;
