/** Contracts for the explicit, consented Chrome-for-Testing installer. */
import { z } from 'zod';

import type {
  CompatibilityEvidenceState,
  CompatibilityResult,
  ManagedReadyRecord,
  ManagedPlatform,
  ProbeFailureClass,
} from './installation-types.js';

export type ConsentSource = 'cli-accept-flag' | 'cli-prompt' | 'interactive-offer';
export interface DownloadConsentRecord {
  readonly granted: true;
  readonly source: ConsentSource;
  readonly grantedAt: string;
  readonly destinationRoot: string;
  readonly approximateBytes: number;
}
export type ManagedInstallTrigger = 'explicit-command' | 'interactive-offer';
export type ManagedInstallPhase =
  | 'preflight'
  | 'collecting-orphans'
  | 'resolving-stable'
  | 'downloading'
  | 'extracting'
  | 'finalizing'
  | 'verifying'
  | 'publishing';
export interface ManagedInstallProgress {
  readonly phase: ManagedInstallPhase;
  readonly buildId: string | null;
  readonly downloadedBytes?: number;
  readonly totalBytes?: number | null;
  readonly percent?: number;
  readonly resumable: false;
  readonly interruptible: boolean;
}
export interface ManagedInstallRequest {
  readonly trigger: ManagedInstallTrigger;
  readonly consent: DownloadConsentRecord;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ManagedInstallProgress) => void;
  readonly deadlineMs?: number;
}
export interface OrphanCollectionReport {
  readonly attempted: number;
  readonly deleted: number;
  readonly bytesReclaimed: number;
  readonly skippedLiveOwner: number;
  readonly failed: readonly { readonly cacheRootRelative: string; readonly reason: string }[];
}
export interface ManagedSelectionNotice {
  readonly configuredSource: 'auto' | 'managed' | 'system' | 'unknown';
  readonly selectsThisInstallation: boolean;
  readonly command: string | null;
}
export type ManagedInstallFailureCode =
  | 'unsupported-platform'
  | 'operation-in-progress'
  | 'consent-required'
  | 'helper-unavailable'
  | 'proxy-unsupported-runtime'
  | 'archive-tool-missing'
  | 'insufficient-disk-space'
  | 'insufficient-permissions'
  | 'metadata-unavailable'
  | 'proxy-failure'
  | 'network-failure'
  | 'extraction-failure'
  | 'helper-crashed'
  | 'timed-out'
  | 'verification-failure'
  | 'compatibility-failure'
  | 'publication-failure';
export interface ManagedInstallError {
  readonly code: ManagedInstallFailureCode;
  readonly phase: ManagedInstallPhase;
  readonly remediation: string;
  readonly detail: string;
  readonly probeFailure?: ProbeFailureClass;
  readonly searchedPaths?: readonly string[];
  readonly proxyHost?: string;
  readonly retainedOrphan: string | null;
}
export type ManagedInstallOutcome =
  | {
      readonly status: 'installed';
      readonly record: ManagedReadyRecord;
      readonly executablePath: string;
      readonly compatibility: CompatibilityResult;
      readonly orphans: OrphanCollectionReport;
      readonly selection: ManagedSelectionNotice;
    }
  | {
      readonly status: 'already-installed';
      readonly record: ManagedReadyRecord;
      readonly executablePath: string;
      readonly compatibility: CompatibilityEvidenceState;
      readonly orphans: OrphanCollectionReport;
      readonly updateCommand: 'yantra browser update';
    }
  | {
      readonly status: 'cancelled';
      readonly at: ManagedInstallPhase;
      readonly retainedOrphan: string | null;
    }
  | { readonly status: 'failed'; readonly error: ManagedInstallError };
export interface ManagedInstallService {
  install(request: ManagedInstallRequest): Promise<ManagedInstallOutcome>;
  collectOrphans(options?: { readonly bestEffort?: boolean }): Promise<OrphanCollectionReport>;
}
export interface ManagedInstallPolicy {
  readonly wholeOperationMs: number;
  readonly metadataMs: number;
  readonly stallMs: number;
  readonly cancelAckMs: number;
  readonly finalizeGraceMs: number;
  readonly treeExitMs: number;
  readonly requiredFreeBytes: number;
  readonly progressIntervalMs: number;
}
export const DEFAULT_MANAGED_INSTALL_POLICY: ManagedInstallPolicy = Object.freeze({
  wholeOperationMs: 15 * 60_000,
  metadataMs: 30_000,
  stallMs: 60_000,
  cancelAckMs: 3_000,
  finalizeGraceMs: 60_000,
  treeExitMs: 10_000,
  requiredFreeBytes: 750 * 1024 * 1024,
  progressIntervalMs: 500,
});

export const HelperRequestSchema = z.object({
  protocolVersion: z.literal(1),
  operationId: z.string().min(1),
  browser: z.literal('chrome'),
  platform: z.enum(['linux', 'mac', 'mac_arm', 'win32', 'win64']),
  cacheDir: z.string().min(1),
  buildId: z.string().min(1).nullable(),
  progressIntervalMs: z.number().int().positive(),
});
export type HelperRequest = z.infer<typeof HelperRequestSchema> & {
  readonly platform: ManagedPlatform;
};
const phase = z.enum([
  'preflight',
  'collecting-orphans',
  'resolving-stable',
  'downloading',
  'extracting',
  'finalizing',
  'verifying',
  'publishing',
]);
export const HelperMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ready'),
    protocolVersion: z.literal(1),
    nodeVersion: z.string(),
    envProxyRequested: z.boolean(),
  }),
  z.object({ kind: z.literal('resolved'), buildId: z.string().min(1) }),
  z.object({ kind: z.literal('phase'), phase, interruptible: z.boolean() }),
  z.object({
    kind: z.literal('progress'),
    downloadedBytes: z.number().nonnegative(),
    totalBytes: z.number().nonnegative().nullable(),
  }),
  z.object({ kind: z.literal('cancel-ack') }),
  z.object({
    kind: z.literal('result'),
    buildId: z.string().min(1),
    executableRelative: z.string().min(1),
  }),
  z.object({
    kind: z.literal('error'),
    code: z.enum([
      'unsupported-platform',
      'metadata-unavailable',
      'proxy-failure',
      'network-failure',
      'extraction-failure',
      'helper-crashed',
      'timed-out',
    ]),
    detail: z.string(),
  }),
]);
export type HelperMessage = z.infer<typeof HelperMessageSchema>;
export const ParentMessageSchema = z.object({ kind: z.literal('cancel') });
