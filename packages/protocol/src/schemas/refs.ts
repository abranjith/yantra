import { z } from 'zod';

const SECRET_KEY_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const PARAM_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const STEP_ID_PATTERN = /^s[0-9]+$/;
const WORKFLOW_LOCATOR_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/;

export interface SecretRef {
  kind: 'secret';
  key: string;
  /** Trusted website host binding metadata. Required for browser fills. */
  hosts?: string[] | undefined;
}

export interface HostBoundSecretRef extends SecretRef {
  hosts: string[];
}

export interface ParamRef {
  kind: 'param';
  key: string;
}

export interface CaptureRef {
  kind: 'capture';
  step_id: string;
  field: string | null;
}

export interface LiteralValue {
  kind: 'literal';
  value: string | number | boolean | null;
}

export interface TemplateRef {
  kind: 'template';
  template: string;
  bindings: Record<string, ValueRef>;
}

export type ValueRef = LiteralValue | ParamRef | SecretRef | CaptureRef | TemplateRef;

/**
 * @example
 * SecretRef.parse({ kind: 'secret', key: 'bank.password' })
 * @example
 * SecretRef.safeParse({ kind: 'secret', key: 'BAD' }).success === false
 */
export const SecretRef = z
  .object({
    kind: z.literal('secret').describe('Discriminator for secret references.'),
    key: z.string().regex(SECRET_KEY_PATTERN).describe('Secret key in namespace.name format.'),
    hosts: z
      .array(z.string().min(1).max(253))
      .min(1)
      .max(32)
      .optional()
      .describe(
        'Trusted website hosts allowed to receive this secret. Required for browser fills.',
      ),
  })
  .describe('Reference to a credential stored outside the plan payload.');

/**
 * @example
 * ParamRef.parse({ kind: 'param', key: 'month' })
 * @example
 * ParamRef.safeParse({ kind: 'param', key: 'Month-1' }).success === false
 */
export const ParamRef = z
  .object({
    kind: z.literal('param').describe('Discriminator for runtime param references.'),
    key: z.string().regex(PARAM_KEY_PATTERN).describe('Declared workflow/task param key.'),
  })
  .describe('Reference to runtime input provided by the user.');

/**
 * @example
 * CaptureRef.parse({ kind: 'capture', step_id: 's1', field: 'amount' })
 * @example
 * CaptureRef.safeParse({ kind: 'capture', step_id: 'step1', field: null }).success === false
 */
export const CaptureRef = z
  .object({
    kind: z.literal('capture').describe('Discriminator for capture references.'),
    step_id: z
      .string()
      .regex(STEP_ID_PATTERN)
      .describe('Extract step id that produced the capture.'),
    field: z
      .string()
      .nullable()
      .describe('Optional extracted field key. Null means the whole capture payload.'),
  })
  .describe('Reference to values captured by a previous extract step.');

export const LiteralValue = z
  .object({
    kind: z.literal('literal').describe('Discriminator for literal values.'),
    value: z
      .union([z.string(), z.number(), z.boolean(), z.null()])
      .describe('Literal scalar value embedded in the plan.'),
  })
  .describe('Literal scalar value.');

/**
 * @example
 * TemplateRef.parse({ kind: 'template', template: 'Hi {{name}}', bindings: { name: { kind: 'param', key: 'name' } } })
 * @example
 * TemplateRef.safeParse({ kind: 'template', template: 'x', bindings: { bad: { kind: 'unknown' } } }).success === false
 */
export const TemplateRef = z
  .object({
    kind: z.literal('template').describe('Discriminator for template-backed values.'),
    template: z.string().describe('Template string with {{placeholder}} markers.'),
    bindings: z
      .record(
        z.string(),
        z.lazy((): z.ZodType<ValueRef> => ValueRef),
      )
      .describe('Typed mapping from placeholder names to value references.'),
  })
  .describe('Templated value with explicit typed bindings.');

export const ValueRef: z.ZodType<ValueRef> = z.lazy(
  (): z.ZodType<ValueRef> =>
    z
      .discriminatedUnion('kind', [LiteralValue, ParamRef, SecretRef, CaptureRef, TemplateRef])
      .describe('Any value reference that can flow through a plan or workflow.'),
);

export const RoleEnum = z
  .enum([
    'button',
    'link',
    'textbox',
    'searchbox',
    'table',
    'heading',
    'region',
    'dialog',
    'listitem',
    'cell',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'slider',
    'spinbutton',
    'option',
    'tab',
    'tabpanel',
    'menuitem',
    'row',
    'grid',
  ])
  .describe(
    'Supported ARIA role intents. Must stay a subset of the roles the locator engine can compute (`getRole`), or a recorded role can never match at replay: `<select>` computes `listbox`, `input[type=search]` computes `searchbox`, and `input[type=number|date|time|month|week]` computes `spinbutton`.',
  );

export type RoleEnum = z.infer<typeof RoleEnum>;

export const NameMatch = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('exact').describe('Exact match strategy.'),
      value: z.string().describe('Exact accessible name value.'),
    }),
    z.object({
      kind: z.literal('regex').describe('Regex match strategy.'),
      pattern: z.string().describe('Regex pattern to compile.'),
      flags: z.string().describe('Regex flags such as i or im.'),
    }),
  ])
  .describe('Accessible-name matcher for intent locators.');

export type NameMatch = z.infer<typeof NameMatch>;

export interface IntentLocatorChain {
  kind: 'intent';
  role: RoleEnum;
  name_match: NameMatch | null;
  near: LocatorChain | null;
}

export type LocatorChain =
  | { kind: 'recorded'; step_index: number }
  | { kind: 'workflow'; name: string }
  | IntentLocatorChain;

export const LocatorChain: z.ZodType<LocatorChain> = z.lazy(() =>
  z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('recorded').describe('Recorded locator candidate index reference.'),
        step_index: z.number().int().nonnegative().describe('Recorded step index.'),
      }),
      z.object({
        kind: z.literal('workflow').describe('Named workflow locator chain reference.'),
        name: z
          .string()
          .regex(WORKFLOW_LOCATOR_PATTERN)
          .describe('Human-readable workflow locator key.'),
      }),
      z.object({
        kind: z.literal('intent').describe('Semantic intent locator that engine resolves.'),
        role: RoleEnum.describe('Target ARIA role.'),
        name_match: NameMatch.nullable().describe('Optional accessible-name matcher.'),
        near: z
          .lazy(() => LocatorChain)
          .nullable()
          .describe('Optional relative anchor.'),
      }),
    ])
    .describe('Locator resolution strategy chain.'),
);
