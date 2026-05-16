/**
 * Internal types for the recorder module.
 *
 * These are Node-side types that don't belong in the protocol package.
 * Nothing here is exported from the public recorder barrel.
 */

import type { CDPSession } from 'puppeteer-core';

import type {
  CapturedAction,
  RawCapturedActionInput,
  StopReason,
} from '@yantra/protocol';

export type { CDPSession };

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

export type RecordingState =
  | 'idle'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'aborted';

// ---------------------------------------------------------------------------
// Session events (emitted on the EventEmitter)
// ---------------------------------------------------------------------------

export interface RecordingStartedEvent {
  readonly kind: 'recording_started';
  readonly recordingId: string;
  readonly workflowNameHint: string;
  readonly recordingDir: string;
  readonly ts: string;
}

export interface CaptureEmittedEvent {
  readonly kind: 'capture_emitted';
  readonly recordingId: string;
  readonly actionIndex: number;
  readonly actionKind: CapturedAction['kind'];
  readonly url: string;
  readonly ts: string;
}

export interface NavigationCapturedEvent {
  readonly kind: 'navigation_captured';
  readonly recordingId: string;
  readonly url_before: string;
  readonly url_after: string;
  readonly navigation_kind: string;
  readonly ts: string;
}

export interface PopupAttachedEvent {
  readonly kind: 'popup_attached';
  readonly recordingId: string;
  readonly targetId: string;
  readonly url: string;
  readonly ts: string;
}

export interface PopupClosedEvent {
  readonly kind: 'popup_closed';
  readonly recordingId: string;
  readonly targetId: string;
  readonly ts: string;
}

export interface UnrecordedFrameEvent {
  readonly kind: 'unrecorded_frame';
  readonly recordingId: string;
  readonly origin: string;
  readonly frameId: string;
  readonly detectedAt: string;
}

export interface IdleTimeoutPromptEvent {
  readonly kind: 'idle_timeout_prompt';
  readonly recordingId: string;
  readonly ts: string;
}

export interface RecordingStoppedEvent {
  readonly kind: 'recording_stopped';
  readonly recordingId: string;
  readonly draftPath: string;
  readonly stopReason: StopReason;
  readonly ts: string;
}

export interface RecordingAbortedEvent {
  readonly kind: 'recording_aborted';
  readonly recordingId: string;
  readonly cause: AbortCause;
  readonly lastActionIndex: number;
  readonly recordingDir: string;
  readonly ts: string;
}

export interface RecordingDegradedEvent {
  readonly kind: 'recording_degraded';
  readonly recordingId: string;
  readonly reason: string;
  readonly ts: string;
}

export type RecordingSessionEvent =
  | RecordingStartedEvent
  | CaptureEmittedEvent
  | NavigationCapturedEvent
  | PopupAttachedEvent
  | PopupClosedEvent
  | UnrecordedFrameEvent
  | IdleTimeoutPromptEvent
  | RecordingStoppedEvent
  | RecordingAbortedEvent
  | RecordingDegradedEvent;

export type AbortCause =
  | 'page_crash'
  | 'browser_disconnected'
  | 'disk_unwritable'
  | 'schema_drift';

// ---------------------------------------------------------------------------
// Raw in-page payload (pre-redaction, never persisted)
// ---------------------------------------------------------------------------

export interface RawInPagePayload {
  kind: 'click' | 'fill' | 'keydown_enter' | 'navigate';
  descriptor: {
    tag: string;
    role: string | null;
    accessible_name: string | null;
    visible_text: string | null;
    attrs_sample: Partial<Record<string, string>>;
    bounding_rect: { x: number; y: number; width: number; height: number };
    in_iframe: boolean;
    xpath_for_debug: string;
  };
  candidate_chain: Array<{
    candidate: unknown;
    score: number;
    rank_reason: string;
  }>;
  raw_value: string | null;
  value_length: number;
  input_type: string;
  ts: number;
  url: string;
}

// ---------------------------------------------------------------------------
// Popup tracking
// ---------------------------------------------------------------------------

export interface PopupEntry {
  readonly targetId: string;
  readonly parentTargetId: string;
  readonly cdpSession: CDPSession;
  readonly url: string;
}
