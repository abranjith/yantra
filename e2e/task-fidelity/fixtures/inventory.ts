/**
 * The task-fidelity truth dataset (FEAT-049).
 *
 * Every listing fixture renders from this one array, and every scorer reads its
 * ground truth from {@link truthRows}, which derives from the same array. The
 * pages and the truth therefore cannot diverge: change an item here and both
 * move together.
 *
 * Everything is fictional — make, model, trims, sellers, and colors. Some items
 * deliberately fail exactly one filter of {@link CANONICAL_FILTERS} (a FWD
 * drivetrain, a used condition, or another trim), so constraint fidelity is
 * measurable: a delivered row from one of them is a violation, not a near miss.
 */

/** One vehicle listing. */
export interface InventoryItem {
  /** Stable identifier; doubles as the detail-page path segment. */
  readonly id: string;
  readonly condition: 'new' | 'used';
  readonly year: number;
  readonly trim: string;
  readonly drivetrain: 'AWD' | 'FWD';
  /** Whole currency units. */
  readonly price: number;
  /** Whole currency units. */
  readonly msrp: number;
  readonly seller: string;
  readonly distanceMi: number;
  /** Rendered only on detail pages, so collecting it requires following detail links. */
  readonly exteriorColor: string;
  /** Rendered only on detail pages, so collecting it requires following detail links. */
  readonly interiorColor: string;
}

/** The fictional make and model every item shares. */
export const MAKE = 'Norvale';
export const MODEL = 'Teyra';

/** The motivating task's location, as the user granted it. */
export const USER_LOCATION = 'fairview';

/** Listing order. Page 1 of a listing shows the first {@link PAGE_SIZE}. */
export const INVENTORY: readonly InventoryItem[] = Object.freeze([
  item(
    'itm-01',
    'new',
    'Summit',
    'AWD',
    50_265,
    50_255,
    'Lakeside Motors',
    27.0,
    'Glacier White',
    'Black Leather',
  ),
  item(
    'itm-02',
    'new',
    'Summit',
    'FWD',
    48_910,
    48_900,
    'Prairie Auto Group',
    12.4,
    'Harbor Blue',
    'Gray Cloth',
  ),
  item(
    'itm-03',
    'new',
    'Summit',
    'AWD',
    49_880,
    49_870,
    'Cedar Hollow Motors',
    8.6,
    'Midnight Black',
    'Saddle Brown Leather',
  ),
  item(
    'itm-04',
    'new',
    'Ridge',
    'AWD',
    45_120,
    45_110,
    'Brightwater Auto Mall',
    33.1,
    'Slate Gray',
    'Black Leather',
  ),
  item(
    'itm-05',
    'used',
    'Summit',
    'AWD',
    44_350,
    50_255,
    'Northgate Motor Co.',
    19.8,
    'Ember Red',
    'Ivory Leather',
  ),
  item(
    'itm-06',
    'new',
    'Summit',
    'AWD',
    51_040,
    51_030,
    'Fairview Auto Plaza',
    2.3,
    'Sandstone Beige',
    'Ivory Leather',
  ),
  item(
    'itm-07',
    'new',
    'Base',
    'AWD',
    39_990,
    39_980,
    'Silver Creek Motors',
    41.7,
    'Forest Green',
    'Gray Cloth',
  ),
  item(
    'itm-08',
    'new',
    'Summit',
    'AWD',
    49_415,
    49_405,
    'Prairie Auto Group',
    12.4,
    'Slate Gray',
    'Black Leather',
  ),
  item(
    'itm-09',
    'new',
    'Summit',
    'FWD',
    47_760,
    47_750,
    'Lakeside Motors',
    27.0,
    'Glacier White',
    'Gray Cloth',
  ),
  item(
    'itm-10',
    'new',
    'Summit',
    'AWD',
    50_730,
    50_720,
    'Northgate Motor Co.',
    19.8,
    'Harbor Blue',
    'Saddle Brown Leather',
  ),
  item(
    'itm-11',
    'new',
    'Ridge',
    'AWD',
    45_875,
    45_865,
    'Cedar Hollow Motors',
    8.6,
    'Ember Red',
    'Black Leather',
  ),
  item(
    'itm-12',
    'used',
    'Summit',
    'AWD',
    43_980,
    50_255,
    'Silver Creek Motors',
    41.7,
    'Midnight Black',
    'Black Leather',
  ),
  item(
    'itm-13',
    'new',
    'Summit',
    'AWD',
    49_995,
    49_985,
    'Brightwater Auto Mall',
    33.1,
    'Forest Green',
    'Ivory Leather',
  ),
  item(
    'itm-14',
    'new',
    'Base',
    'AWD',
    40_450,
    40_440,
    'Fairview Auto Plaza',
    2.3,
    'Sandstone Beige',
    'Gray Cloth',
  ),
]);

/** Cards per listing page. */
export const PAGE_SIZE = 6;

/** A truth field a scenario contract may require. */
export type FieldName =
  | 'title'
  | 'condition'
  | 'year'
  | 'trim'
  | 'drivetrain'
  | 'price'
  | 'msrp'
  | 'seller'
  | 'distance'
  | 'exteriorColor'
  | 'interiorColor';

/** A truth field a scenario contract may filter on. */
export type FilterName = 'condition' | 'year' | 'trim' | 'drivetrain';

/** The motivating task's filters: new, 2026, the top trim, AWD. */
export const CANONICAL_FILTERS: Readonly<Record<FilterName, string>> = Object.freeze({
  condition: 'new',
  year: '2026',
  trim: 'Summit',
  drivetrain: 'AWD',
});

/** Ground truth for one item, derived — never hand-written. */
export interface TruthRow {
  readonly itemId: string;
  /** The row identity a delivered answer must carry to be matched. */
  readonly key: { readonly title: string; readonly seller: string };
  /** Each field exactly as a fixture page renders it. */
  readonly fields: Readonly<Record<FieldName, string>>;
  /** Whether the item satisfies each of {@link CANONICAL_FILTERS}. */
  readonly satisfies: Readonly<Record<FilterName, boolean>>;
  /** The item's detail page on `faceted-listing`. */
  readonly detailUrl: string;
  /** The unfiltered `faceted-listing` results page that shows the item's card. */
  readonly listingUrl: string;
}

/** The `faceted-listing` origin; the truth's URLs point at it. */
export const FACETED_LISTING_ORIGIN = 'http://faceted-listing.yantra.test';

/** The card and detail-page title of an item. */
export function titleOf(entry: InventoryItem): string {
  const condition = entry.condition === 'new' ? 'New' : 'Used';
  return `${condition} ${entry.year} ${MAKE} ${MODEL} ${entry.trim}`;
}

/** A whole-unit amount with grouping separators and no currency sign (`50,265`). */
export function formatAmount(amount: number): string {
  return amount.toLocaleString('en-US');
}

/** A distance as the listing card renders it (`27.0 mi`). */
export function formatDistance(distanceMi: number): string {
  return `${distanceMi.toFixed(1)} mi`;
}

/** The 1-based listing page that shows an item when no filter is applied. */
export function listingPageOf(itemId: string): number {
  const index = INVENTORY.findIndex((entry) => entry.id === itemId);
  if (index < 0) throw new Error(`unknown inventory item ${itemId}`);
  return Math.floor(index / PAGE_SIZE) + 1;
}

/**
 * The ground truth, one row per inventory item, in listing order.
 *
 * Derived by the same module the renderers read, so a page cannot show a value
 * the truth does not hold.
 */
export function truthRows(): readonly TruthRow[] {
  return INVENTORY.map((entry) => {
    const fields: Record<FieldName, string> = {
      title: titleOf(entry),
      condition: entry.condition,
      year: String(entry.year),
      trim: entry.trim,
      drivetrain: entry.drivetrain,
      price: formatAmount(entry.price),
      msrp: formatAmount(entry.msrp),
      seller: entry.seller,
      distance: formatDistance(entry.distanceMi),
      exteriorColor: entry.exteriorColor,
      interiorColor: entry.interiorColor,
    };
    const satisfies = Object.fromEntries(
      (Object.keys(CANONICAL_FILTERS) as FilterName[]).map((name) => [
        name,
        fields[name].toLowerCase() === CANONICAL_FILTERS[name].toLowerCase(),
      ]),
    ) as Record<FilterName, boolean>;
    const page = listingPageOf(entry.id);
    return {
      itemId: entry.id,
      key: { title: fields.title, seller: entry.seller },
      fields,
      satisfies,
      detailUrl: `${FACETED_LISTING_ORIGIN}/vehicle/${entry.id}`,
      listingUrl: `${FACETED_LISTING_ORIGIN}/new/results${page === 1 ? '' : `?page=${page}`}`,
    };
  });
}

function item(
  id: string,
  condition: InventoryItem['condition'],
  trim: string,
  drivetrain: InventoryItem['drivetrain'],
  price: number,
  msrp: number,
  seller: string,
  distanceMi: number,
  exteriorColor: string,
  interiorColor: string,
): InventoryItem {
  return {
    id,
    condition,
    year: 2026,
    trim,
    drivetrain,
    price,
    msrp,
    seller,
    distanceMi,
    exteriorColor,
    interiorColor,
  };
}
