/**
 * Zod schemas for the recorder's draft artifact.
 *
 * The `RecordingDraft` is produced by the recorder (FEAT-008) and consumed by
 * the annotate flow (FEAT-009). It is the authoritative on-disk representation
 * of one recording session.
 *
 * Security invariants enforced at the type level:
 *   - `fill.raw_value` is `z.literal('<redacted>')` — any other string is a type error.
 *   - `RawCapturedActionInput` (pre-redaction shape) is NOT exported from this module.
 */

import { z } from 'zod';

import { SUPPORTED_SCHEMA_VERSIONS } from '../version.js';

// ---------------------------------------------------------------------------
// ElementDescriptor — sanitized structural fingerprint of the captured element
// ---------------------------------------------------------------------------

/** Attribute keys that may appear in attrs_sample. All other attributes are dropped. */
const SAMPLED_ATTR_KEYS = [
  'id',
  'name',
  'data-testid',
  'data-qa',
  'data-cy',
  'placeholder',
  'aria-label',
  'href',
  'type',
] as const;

export const ElementDescriptorSchema = z
  .object({
    tag: z.string().describe('Lowercase tag name, e.g. "button"'),
    role: z.string().nullable().describe('ARIA computed role, or null if not applicable'),
    accessible_name: z
      .string()
      .max(200)
      .nullable()
      .describe('ARIA accessible name, truncated to 200 chars'),
    visible_text: z
      .string()
      .max(200)
      .nullable()
      .describe('innerText truncated to 200 chars with normalized whitespace'),
    attrs_sample: z
      .record(z.enum(SAMPLED_ATTR_KEYS), z.string().max(100))
      .describe('Sampled subset of element attributes — only whitelisted keys, max 100 chars each'),
    bounding_rect: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .describe('Element bounding rectangle in page coordinates'),
    in_iframe: z.boolean().describe('True if the element lives inside an iframe'),
    xpath_for_debug: z
      .string()
      .max(200)
      .describe('Absolute XPath, shown only with --debug, never used for replay'),
  })
  .describe('Sanitized structural fingerprint of a captured DOM element');

export type ElementDescriptor = z.infer<typeof ElementDescriptorSchema>;

// ---------------------------------------------------------------------------
// RankedCandidate — one entry in the locator candidate chain
// ---------------------------------------------------------------------------

/**
 * Mirrors LocatorIntent from packages/core/src/locator/types.ts as a plain-JSON
 * shape suitable for serialization in draft.json.
 */
const LocatorIntentJsonSchema = z
  .object({
    kind: z.enum(['role', 'testid', 'label', 'placeholder', 'text', 'css', 'xpath', 'relative']),
  })
  .passthrough()
  .describe('Serialized locator intent (JSON-safe form of LocatorIntent)');

export const RankedCandidateSchema = z
  .object({
    candidate: LocatorIntentJsonSchema.describe('The locator intent for this candidate'),
    score: z
      .number()
      .min(0)
      .max(1.5)
      .describe('Ranking score from 0..1 (may be slightly > 1 for boosted candidates)'),
    rank_reason: z.string().describe('Short human label explaining the score'),
  })
  .describe('One entry in the ranked locator candidate chain');

export type RankedCandidate = z.infer<typeof RankedCandidateSchema>;

// ---------------------------------------------------------------------------
// InputTypeHint — structural metadata for fill actions
// ---------------------------------------------------------------------------

export const InputTypeHintSchema = z
  .enum(['text', 'email', 'password', 'tel', 'number', 'url', 'search', 'textarea', 'other'])
  .describe('Input type from the DOM — purely structural, no value content');

export type InputTypeHint = z.infer<typeof InputTypeHintSchema>;

// ---------------------------------------------------------------------------
// CapturedAction — the discriminated union for all captured events
// ---------------------------------------------------------------------------

const BaseActionFields = {
  ts: z.string().describe('ISO-8601 timestamp (page clock via performance.now() + timeOrigin)'),
  url_before: z.string().url().describe('Page URL at the time of the action'),
  url_after: z
    .string()
    .url()
    .nullable()
    .describe('Page URL after the action, null if no navigation within 500ms'),
};

export const ClickActionSchema = z
  .object({
    kind: z.literal('click'),
    element_descriptor: ElementDescriptorSchema,
    candidate_chain: z
      .array(RankedCandidateSchema)
      .max(5)
      .describe('Top-5 ranked locator candidates'),
    ...BaseActionFields,
  })
  .describe('A user click event');

/** Pre-redaction shape — INTERNAL ONLY, never exported from recorder/index.ts */
export const RawFillActionSchema = z.object({
  kind: z.literal('fill'),
  element_descriptor: ElementDescriptorSchema,
  candidate_chain: z.array(RankedCandidateSchema).max(5),
  ts: z.string(),
  url_before: z.string(),
  url_after: z.string().nullable(),
  raw_value: z.string().describe('The actual typed value — MUST be redacted before persistence'),
  value_length: z.number().int().nonnegative(),
  input_type: InputTypeHintSchema,
});

export type RawFillAction = z.infer<typeof RawFillActionSchema>;

export const FillActionSchema = z
  .object({
    kind: z.literal('fill'),
    element_descriptor: ElementDescriptorSchema,
    candidate_chain: z
      .array(RankedCandidateSchema)
      .max(5)
      .describe('Top-5 ranked locator candidates'),
    ...BaseActionFields,
    raw_value: z
      .literal('<redacted>')
      .describe('Always the literal string "<redacted>" — type system enforces this'),
    value_length: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of code points the user typed (not PII)'),
    input_type: InputTypeHintSchema,
  })
  .describe('A form fill event — value is always redacted');

export const NavigateActionSchema = z
  .object({
    kind: z.literal('navigate'),
    ts: z.string(),
    url_before: z.string(),
    url_after: z.string(),
    navigation_kind: z
      .enum(['user_click', 'programmatic', 'address_bar', 'history', 'popup'])
      .describe('How the navigation was triggered'),
    triggered_by_action_index: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        'Index of the click action that triggered this navigation, null for non-click navigations',
      ),
  })
  .describe('A page navigation event');

export const WaitActionSchema = z
  .object({
    kind: z.literal('wait'),
    ts: z.string(),
    reason: z.enum(['dom_content_loaded', 'network_idle', 'manual_dwell']),
    duration_ms: z.number().int().nonnegative().describe('Dwell duration in milliseconds'),
    url: z.string().describe('URL of the page during the dwell'),
  })
  .describe('A wait/dwell event between user actions');

export const CapturedActionSchema = z
  .discriminatedUnion('kind', [
    ClickActionSchema,
    FillActionSchema,
    NavigateActionSchema,
    WaitActionSchema,
  ])
  .describe('One captured user action during recording');

export type CapturedAction = z.infer<typeof CapturedActionSchema>;
export type ClickAction = z.infer<typeof ClickActionSchema>;
export type FillAction = z.infer<typeof FillActionSchema>;
export type NavigateAction = z.infer<typeof NavigateActionSchema>;
export type WaitAction = z.infer<typeof WaitActionSchema>;

/** Pre-redaction input type — only used inside the recorder module, never exported publicly. */
export type RawCapturedActionInput = ClickAction | RawFillAction | NavigateAction | WaitAction;

// ---------------------------------------------------------------------------
// RecordingMetadata — session-level metadata
// ---------------------------------------------------------------------------

export const RecordingMetadataSchema = z
  .object({
    start_ts: z.string().describe('ISO-8601 recording start timestamp'),
    end_ts: z
      .string()
      .nullable()
      .describe('ISO-8601 recording end timestamp, null until stop/abort'),
    os: z.object({
      platform: z.string(),
      release: z.string(),
      arch: z.string(),
    }),
    chrome_version: z.string().describe('Full Chrome version string, e.g. "124.0.6367.91"'),
    chrome_major: z
      .number()
      .int()
      .positive()
      .describe('Chrome major version, parsed from chrome_version'),
    yantra_version: z.string().describe('yantra CLI version from package.json'),
    initial_url: z.string().describe('First navigation URL captured during the session'),
    capture_count: z.number().int().nonnegative().describe('Total number of captured actions'),
    dwell_per_page: z
      .array(z.object({ url: z.string(), ms: z.number().int().nonnegative() }))
      .describe('Time spent on each page URL during recording'),
    stop_reason: z
      .enum(['user', 'idle_timeout', 'crash', 'page_close'])
      .describe('Why the recording ended'),
    unrecorded_frame_origins: z
      .array(z.string())
      .describe('Cross-origin iframe origins detected but not instrumented — see TASK-006a'),
  })
  .describe('Session-level metadata written to metadata.json and embedded in draft.json');

export type RecordingMetadata = z.infer<typeof RecordingMetadataSchema>;

// ---------------------------------------------------------------------------
// RecordingDraft — the top-level artifact written by the recorder
// ---------------------------------------------------------------------------

export const StopReasonSchema = z.enum(['user', 'idle_timeout', 'crash', 'page_close']);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const RecordingDraftSchema = z
  .object({
    schema_version: z
      .enum(SUPPORTED_SCHEMA_VERSIONS)
      .describe('Schema version for forward-compatibility checks'),
    recording_id: z.string().min(1).describe('ULID-formatted recording identifier'),
    workflow_name_hint: z
      .string()
      .min(1)
      .describe('Workflow name hint from RecordingSession.start()'),
    started_at: z.string().describe('ISO-8601 session start timestamp'),
    stopped_at: z.string().describe('ISO-8601 session stop timestamp'),
    stop_reason: StopReasonSchema.describe('Reason the recording ended'),
    actions: z.array(CapturedActionSchema).describe('Ordered list of captured actions'),
    metadata: RecordingMetadataSchema,
  })
  .describe('The complete recording draft artifact produced by the recorder (FEAT-008)');

export type RecordingDraft = z.infer<typeof RecordingDraftSchema>;
