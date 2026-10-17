/** Synthetic form ground truth; this subpath never imports Vitest. */
export type MatrixLabelOrigin = 'explicit' | 'structural' | 'placeholder' | 'title' | 'none';
export interface MatrixControl {
  readonly key: string;
  readonly role: string;
  readonly expect:
    | { readonly kind: 'label'; readonly query: string; readonly origin: MatrixLabelOrigin }
    | { readonly kind: 'ambiguous'; readonly query: string; readonly with: readonly string[] }
    | { readonly kind: 'ref-only' };
}
export interface MatrixPage {
  readonly id: string;
  readonly pattern: string;
  html(): string;
  readonly controls: readonly MatrixControl[];
}
