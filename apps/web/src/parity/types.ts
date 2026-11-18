import type { RunEventKind } from '@yantra/protocol/parity';

export type IsoDate = `${number}-${number}-${number}`;
export type CommandPathKey = string;
export type OptionKey = `${string} --${string}`;
export type SurfaceId = string;
export type InstrumentName =
  'timeline' | 'contract' | 'requirements' | 'budgets' | 'top_bar' | 'status' | 'outcome';
export type ArtifactViewerId =
  'brief' | 'document' | 'markdown' | 'json' | 'jsonl' | 'text' | 'image' | 'download';
export type AdapterId =
  'config-edit-yaml' | 'open-result-view' | 'daemon-control' | 'confirm-inbox' | 'init-onboarding';

export type ParityTarget =
  | { readonly kind: 'surface'; readonly surface: SurfaceId }
  | { readonly kind: 'instrument'; readonly instrument: InstrumentName }
  | { readonly kind: 'inspector' }
  | { readonly kind: 'viewer'; readonly viewer: ArtifactViewerId }
  | { readonly kind: 'denied'; readonly reason: string }
  | { readonly kind: 'adapter'; readonly adapter: AdapterId; readonly surface: SurfaceId }
  | { readonly kind: 'exemption'; readonly reason: string; readonly reviewed: IsoDate }
  | { readonly kind: 'reserved'; readonly feature: 'FEAT-071'; readonly surface: SurfaceId };

export type OptionParity =
  | { readonly kind: 'field' }
  | { readonly kind: 'exemption'; readonly reason: string; readonly reviewed: IsoDate }
  | { readonly kind: 'adapter_action'; readonly label: string }
  | { readonly kind: 'dead'; readonly allowlist: 'KNOWN_DEAD_OPTIONS' };

export interface ParityManifest {
  readonly commands: Readonly<Record<CommandPathKey, ParityTarget>>;
  readonly options: Readonly<Record<OptionKey, OptionParity>>;
  readonly events: Readonly<Record<RunEventKind, ParityTarget>>;
  readonly artifacts: Readonly<Record<string, ParityTarget>>;
}
