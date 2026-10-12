/**
 * Shape-aware page analysis types (FEAT-051).
 *
 * An article extractor reads every page as prose, which is right for an
 * article and wrong for everything else: on a results page it keeps fragments
 * of each card and drops the rest (G2), and it never reports the links a page
 * offers (G3). These types describe what a page *is* — its {@link PageShape} —
 * and the data that kind of page actually holds: repeated records, label/value
 * fields, every table, schema.org entities, and the links it offers. A
 * {@link PageCoverage} statement says what was found, shown, dropped, and
 * looked for but absent, so a reader never has to guess why data is missing.
 *
 * Everything here is structural. No type, field, or constant names a site.
 */

import type { ExtractedArticle } from '../types.js';

/**
 * What kind of page a read found.
 *
 * - `article`: prose; Readability's text is the content.
 * - `collection`: repeated records (a listing, results page, or `ItemList`).
 * - `table`: the content is in data tables.
 * - `detail`: one item's label/value attributes (a product or vehicle page).
 * - `index`: no readable content of its own, but links to follow (a hub).
 *
 * A challenge page is never a success shape: it is a `SITE_CHALLENGE` failure
 * on every read path, because a challenge page must never be extracted.
 */
export type PageShape = 'article' | 'collection' | 'table' | 'detail' | 'index';

/**
 * Why a link is offered.
 *
 * - `pagination`: the next/previous/numbered page of the same listing.
 * - `facet`: a refinement of the current listing (a filter value with a count).
 * - `record`: the primary link of a record.
 * - `content`: any other link in the page's content.
 * - `navigation`: a link inside a `nav`/`header`/`footer`/`aside` landmark (or
 *   `role=navigation|banner|contentinfo|complementary`).
 */
export type LinkKind = 'pagination' | 'facet' | 'record' | 'content' | 'navigation';

/** One link a page offers. */
export interface PageLink {
  /** Accessible text (≤ 80 chars): link text, else aria-label, title, then img alt. */
  readonly text: string;
  /** Absolute http(s) URL, resolved against `<base href>` or the page URL. */
  readonly url: string;
  readonly kind: LinkKind;
  /** Whether the link stays on the page's own host. */
  readonly sameSite: boolean;
}

/** A typed number found in record text. */
export interface NumericToken {
  readonly kind: 'currency' | 'distance' | 'count';
  /** The matched span, as written. */
  readonly text: string;
  /** The parsed value, grouping separators removed. */
  readonly value: number;
}

/** One label/value pair. */
export interface PageField {
  readonly label: string;
  readonly value: string;
}

/** A secondary link inside a record (a seller, a dealer page). */
export interface RecordLink {
  readonly text: string;
  readonly url: string;
}

/** One repeated item of a collection (a card, a result row). */
export interface PageRecord {
  /**
   * Identity for stable anchors: the canonical primary URL when one exists,
   * otherwise a hash of the normalized title plus the first segment. Unique
   * within one analysis (a repeat gets a `#<n>` suffix).
   */
  readonly key: string;
  /** First heading, else the primary link's text, else the first segment. */
  readonly title: string | null;
  /** The primary link: the anchor wrapping or nearest the title, else the longest-text anchor. */
  readonly url: string | null;
  /** Visible block-level text runs in document order, de-duplicated, title excluded. */
  readonly segments: readonly string[];
  /** At most 8 label/value pairs. */
  readonly fields: readonly PageField[];
  /** At most 6 typed numbers. */
  readonly numbers: readonly NumericToken[];
  /** At most 3 secondary links. */
  readonly links: readonly RecordLink[];
}

/** One schema.org entity (JSON-LD or microdata), flattened and bounded. */
export interface StructuredEntity {
  /** The allowlisted schema.org type that admitted it. */
  readonly type: string;
  readonly from: 'json-ld' | 'microdata';
  /** Dotted keys (`offers.price`, `offers.0.seller.name`) to scalar values. */
  readonly props: Readonly<Record<string, string | number | boolean>>;
}

/** One `<table>`. */
export interface PageTable {
  /** 0-based document-order ordinal among all tables (nested included, pre-order). */
  readonly index: number;
  readonly kind: 'data' | 'key-value' | 'layout';
  readonly caption: string | null;
  readonly headers: readonly string[];
  /** Body rows; always empty for a `layout` table. */
  readonly rows: readonly (readonly string[])[];
}

/**
 * A bound that dropped data. Core states the fact; the agent renders it
 * through its registered message templates (each declaring the capability its
 * advice names), so every phrase a model reads is one registered string.
 */
export type OmissionId =
  | 'records-beyond-limit'
  | 'record-text-cut'
  | 'links-beyond-limit'
  | 'tables-beyond-limit'
  | 'table-rows-beyond-limit'
  | 'table-columns-beyond-limit'
  | 'structured-beyond-limit'
  | 'structured-blocks-skipped'
  | 'fields-beyond-limit'
  | 'snapshot-truncated';

/** One omission: what was dropped and how much. */
export interface Omission {
  readonly id: OmissionId;
  readonly count: number;
  /** The table a row/column omission applies to. */
  readonly table?: number;
  /** Whether the read offers a pagination link (records beyond the limit may be on the next page). */
  readonly paginationOffered?: boolean;
}

/** What extraction found, showed, dropped, and looked for without finding. */
export interface PageCoverage {
  /** One sentence naming why the shape won, with the runner-up's mass. */
  readonly shape_basis: string;
  readonly fetch_mode: 'http' | 'browser';
  readonly records?: {
    readonly found: number;
    readonly shown: number;
    readonly with_link: number;
    readonly with_fields: number;
    /** Records whose text was cut at a segment boundary to fit the per-record bound. */
    readonly truncated: number;
    /** Other qualifying repeated regions that lost to the winning one. */
    readonly other_regions: number;
  };
  readonly links?: {
    readonly found: number;
    readonly shown: number;
    /** Links not offered because the model-visible transform would alter them (agent side). */
    readonly withheld: number;
    readonly by_kind: Partial<Record<LinkKind, number>>;
  };
  readonly tables?: { readonly found: number; readonly shown: number };
  readonly structured?: {
    readonly found: number;
    readonly shown: number;
    readonly types: readonly string[];
    readonly ignored_types: readonly string[];
    /** JSON-LD blocks that failed to parse or exceeded a byte bound. */
    readonly malformed: number;
    readonly skipped_bytes: number;
  };
  readonly fields?: { readonly found: number; readonly shown: number };
  readonly text?: { readonly chars: number; readonly shown: number };
  /** Fixed phrases for what was looked for and absent ("no repeated records"). */
  readonly not_found: readonly string[];
  /** One entry per bound that dropped data (rendered to a fixed phrase by the agent). */
  readonly omitted: readonly Omission[];
}

/** The shape-aware view of one page. */
export interface PageAnalysis {
  /** The page's shape, or `null` when nothing at all could be read ("empty"). */
  readonly shape: PageShape | null;
  /** At most 25. */
  readonly records: readonly PageRecord[];
  /** At most 25. */
  readonly structured: readonly StructuredEntity[];
  /** At most 10; `tables[i].index === i`. */
  readonly tables: readonly PageTable[];
  /** At most 60 page-level label/value pairs. */
  readonly fields: readonly PageField[];
  /** At most 40, record primary links excluded. */
  readonly links: readonly PageLink[];
  /** Record primary links found (excluded from {@link links}). */
  readonly recordLinkCount: number;
  /**
   * Readability's article text when an article exists; otherwise the body's
   * visible text, block-structured through the same normalization pass.
   */
  readonly readableText: string;
  readonly coverage: PageCoverage;
}

/** The result of a shape-aware read: the article (when Readability found one) and the analysis. */
export interface PageExtraction {
  readonly article: ExtractedArticle | null;
  readonly page: PageAnalysis;
}
