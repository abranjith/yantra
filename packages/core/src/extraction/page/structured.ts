/**
 * Schema.org structured data — JSON-LD and microdata — read as untrusted,
 * bounded data (FEAT-051, plan §6 "structured data is untrusted input").
 *
 * Some collections exist only as markup: FEAT-049's `structured-listing`
 * shows a thin visible shell while a JSON-LD `ItemList` carries every product
 * and offer. Before this module, JSON-LD was read only for `datePublished`.
 *
 * Safety properties:
 *
 * - JSON-LD is `JSON.parse`d and never evaluated; a block is read only up to
 *   {@link JSONLD_SCRIPT_BYTES}, all blocks together only up to
 *   {@link JSONLD_TOTAL_BYTES}, and walks stop at {@link STRUCTURED_DEPTH}.
 * - Only entities whose `@type` is in {@link SCHEMA_TYPE_ALLOWLIST} are kept;
 *   every other type is counted in `ignored_types`.
 * - Flattened props are bounded by depth, count, string length, and bytes.
 * - Strings are returned as data. They reach the model only through the same
 *   middleware sanitizer as page text.
 *
 * Malformed or oversized blocks are counted into coverage, never swallowed.
 */

import { attrOf, closest, cleanRun, tagOf, type PageIndex, type PageNode } from './dom.js';
import type { StructuredEntity } from './types.js';

/** Bytes read from one JSON-LD script; larger blocks are skipped and counted. */
export const JSONLD_SCRIPT_BYTES = 256 * 1024;

/** Bytes read across all JSON-LD scripts on a page. */
export const JSONLD_TOTAL_BYTES = 1024 * 1024;

/** Depth the entity walk descends into a JSON-LD value. */
export const STRUCTURED_DEPTH = 6;

/** Depth flattening keeps (`offers.seller.address.city` is depth 4). */
export const FLATTEN_DEPTH = 4;

/** Entities shown per page. */
export const MAX_STRUCTURED = 25;

/** Properties kept per entity. */
export const MAX_PROPS = 40;

/** Characters kept per string property. */
export const PROP_STRING_MAX = 300;

/** Serialized bytes kept per entity. */
export const ENTITY_BYTES_MAX = 2048;

/** Array elements of objects indexed per property (`offers.0` … `offers.2`). */
const ARRAY_OBJECTS_MAX = 3;

/**
 * The schema.org root types this reader admits. The vocabulary is schema.org's
 * (https://schema.org/docs/full.html); every entry is a vocabulary name, not a
 * site, in the same category as ARIA roles.
 */
export const SCHEMA_TYPE_ROOTS: readonly string[] = Object.freeze([
  'Product',
  'Offer',
  'AggregateOffer',
  'ItemList',
  'Organization',
  'Place',
  'Event',
]);

/**
 * Hand-maintained schema.org subtypes of {@link SCHEMA_TYPE_ROOTS}, each
 * mapped to its parent type. A test asserts every entry reaches a root.
 * (`LocalBusiness` is both an `Organization` and a `Place` in schema.org; it is
 * filed under `Organization`.)
 */
export const SUBTYPE_OF: Readonly<Record<string, string>> = Object.freeze({
  // Product
  IndividualProduct: 'Product',
  ProductModel: 'Product',
  ProductGroup: 'Product',
  SomeProducts: 'Product',
  Vehicle: 'Product',
  Car: 'Vehicle',
  Motorcycle: 'Vehicle',
  BusOrCoach: 'Vehicle',
  MotorizedBicycle: 'Vehicle',
  // Offer
  OfferForLease: 'Offer',
  OfferForPurchase: 'Offer',
  // Organization
  Corporation: 'Organization',
  EducationalOrganization: 'Organization',
  GovernmentOrganization: 'Organization',
  NGO: 'Organization',
  OnlineBusiness: 'Organization',
  OnlineStore: 'OnlineBusiness',
  SportsOrganization: 'Organization',
  Airline: 'Organization',
  LocalBusiness: 'Organization',
  AutomotiveBusiness: 'LocalBusiness',
  AutoDealer: 'AutomotiveBusiness',
  AutoRental: 'AutomotiveBusiness',
  AutoRepair: 'AutomotiveBusiness',
  Store: 'LocalBusiness',
  AutoPartsStore: 'Store',
  BikeStore: 'Store',
  BookStore: 'Store',
  ClothingStore: 'Store',
  ComputerStore: 'Store',
  ElectronicsStore: 'Store',
  FurnitureStore: 'Store',
  GroceryStore: 'Store',
  HardwareStore: 'Store',
  HomeGoodsStore: 'Store',
  MotorcycleDealer: 'Store',
  SportingGoodsStore: 'Store',
  FoodEstablishment: 'LocalBusiness',
  Bakery: 'FoodEstablishment',
  BarOrPub: 'FoodEstablishment',
  CafeOrCoffeeShop: 'FoodEstablishment',
  FastFoodRestaurant: 'FoodEstablishment',
  Restaurant: 'FoodEstablishment',
  LodgingBusiness: 'LocalBusiness',
  BedAndBreakfast: 'LodgingBusiness',
  Campground: 'LodgingBusiness',
  Hostel: 'LodgingBusiness',
  Hotel: 'LodgingBusiness',
  Motel: 'LodgingBusiness',
  Resort: 'LodgingBusiness',
  VacationRental: 'LodgingBusiness',
  RealEstateAgent: 'LocalBusiness',
  TravelAgency: 'LocalBusiness',
  EntertainmentBusiness: 'LocalBusiness',
  SportsActivityLocation: 'LocalBusiness',
  // Place
  Accommodation: 'Place',
  Apartment: 'Accommodation',
  House: 'Accommodation',
  SingleFamilyResidence: 'House',
  Room: 'Accommodation',
  HotelRoom: 'Room',
  Suite: 'Accommodation',
  CampingPitch: 'Accommodation',
  Residence: 'Place',
  ApartmentComplex: 'Residence',
  GatedResidenceCommunity: 'Residence',
  CivicStructure: 'Place',
  Airport: 'CivicStructure',
  Museum: 'CivicStructure',
  Park: 'CivicStructure',
  StadiumOrArena: 'CivicStructure',
  TouristAttraction: 'Place',
  TouristDestination: 'Place',
  Landform: 'Place',
  // Event
  BusinessEvent: 'Event',
  ChildrensEvent: 'Event',
  ComedyEvent: 'Event',
  CourseInstance: 'Event',
  DanceEvent: 'Event',
  EducationEvent: 'Event',
  ExhibitionEvent: 'Event',
  Festival: 'Event',
  FoodEvent: 'Event',
  LiteraryEvent: 'Event',
  MusicEvent: 'Event',
  SaleEvent: 'Event',
  ScreeningEvent: 'Event',
  SocialEvent: 'Event',
  SportsEvent: 'Event',
  TheaterEvent: 'Event',
  VisualArtsEvent: 'Event',
});

/** Every admitted type: the roots plus their listed subtypes. */
export const SCHEMA_TYPE_ALLOWLIST: ReadonlySet<string> = new Set([
  ...SCHEMA_TYPE_ROOTS,
  ...Object.keys(SUBTYPE_OF),
]);

/**
 * The root an allowlisted type belongs to, or null for a type outside the
 * allowlist. Cycle-safe.
 *
 * @param type A schema.org type name.
 */
export function rootTypeOf(type: string): string | null {
  const visited = new Set<string>();
  let current: string | undefined = type;
  while (current !== undefined && !visited.has(current)) {
    if (SCHEMA_TYPE_ROOTS.includes(current)) return current;
    visited.add(current);
    current = SUBTYPE_OF[current];
  }
  return null;
}

/** Parsed JSON-LD blocks plus what bounds and parse failures cost. */
export interface JsonLdBlocks {
  readonly values: readonly unknown[];
  /** Blocks that failed to parse or exceeded a byte bound. */
  readonly malformed: number;
  /** Bytes of blocks skipped by a bound. */
  readonly skippedBytes: number;
}

/**
 * Parses JSON-LD script bodies under the byte bounds. The one JSON-LD
 * grammar: the article reader's `datePublished` lookup uses it too.
 *
 * @param texts Script bodies, in document order.
 */
export function parseJsonLdBlocks(texts: readonly string[]): JsonLdBlocks {
  const values: unknown[] = [];
  let malformed = 0;
  let skippedBytes = 0;
  let total = 0;
  for (const text of texts) {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > JSONLD_SCRIPT_BYTES || total + bytes > JSONLD_TOTAL_BYTES) {
      malformed += 1;
      skippedBytes += bytes;
      continue;
    }
    total += bytes;
    try {
      values.push(JSON.parse(text) as unknown);
    } catch {
      // counted: a malformed block is a coverage fact, and the others still parse.
      malformed += 1;
    }
  }
  return { values, malformed, skippedBytes };
}

/**
 * The first string value of `key` anywhere in the parsed blocks, depth-first,
 * bounded by {@link STRUCTURED_DEPTH}.
 *
 * @param values Parsed JSON-LD blocks.
 * @param key The property name.
 */
export function findJsonLdString(values: readonly unknown[], key: string): string | undefined {
  const visit = (value: unknown, depth: number): string | undefined => {
    if (depth > STRUCTURED_DEPTH || typeof value !== 'object' || value === null) return undefined;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const own = record[key];
    if (typeof own === 'string') return own;
    for (const nested of Object.values(record)) {
      const found = visit(nested, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const value of values) {
    const found = visit(value, 0);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** One entity before bounding, with where it came from. */
interface FoundEntity {
  readonly entity: StructuredEntity;
  /** The `ItemList` (by position in discovery order) that held it, or null. */
  readonly list: number | null;
  readonly topLevel: boolean;
  readonly root: string;
}

/** Everything the structured reader found. */
export interface StructuredScan {
  /** Up to {@link MAX_STRUCTURED} entities. */
  readonly entities: readonly StructuredEntity[];
  readonly found: number;
  readonly types: readonly string[];
  readonly ignoredTypes: readonly string[];
  readonly malformed: number;
  readonly skippedBytes: number;
  /** Most allowlisted entities held by one `ItemList`. */
  readonly largestList: number;
  /** Most top-level (non-`ItemList`) entities sharing one root. */
  readonly topLevelSameRoot: number;
  /** Top-level non-`ItemList` entities with at least 4 properties. */
  readonly mainEntities: readonly StructuredEntity[];
}

/**
 * Reads every JSON-LD block and microdata item on the page.
 *
 * @param index The page index (over the untouched parse; scripts intact).
 */
export function readStructured(index: PageIndex): StructuredScan {
  const scripts = index.select(
    (node) =>
      tagOf(node) === 'script' &&
      (attrOf(node, 'type') ?? '').split(';')[0]?.trim().toLowerCase() === 'application/ld+json',
  );
  const blocks = parseJsonLdBlocks(scripts.map(scriptText));
  const found: FoundEntity[] = [];
  const ignored = new Set<string>();
  let listCount = 0;

  const walk = (
    value: unknown,
    depth: number,
    from: StructuredEntity['from'],
    list: number | null,
    topLevel: boolean,
  ): void => {
    if (depth > STRUCTURED_DEPTH || typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, from, list, topLevel);
      return;
    }
    const record = value as Record<string, unknown>;
    if (Array.isArray(record['@graph'])) walk(record['@graph'], depth + 1, from, list, topLevel);
    const types = typesOf(record);
    const admitted = types.find((type) => SCHEMA_TYPE_ALLOWLIST.has(type));
    if (admitted === undefined) {
      for (const type of types) ignored.add(type);
      return;
    }
    const root = rootTypeOf(admitted) ?? admitted;
    if (root === 'ItemList') {
      const listId = listCount;
      listCount += 1;
      found.push({ entity: toEntity(admitted, from, record), list: null, topLevel, root });
      const elements = record.itemListElement;
      for (const element of Array.isArray(elements) ? elements : [elements]) {
        if (typeof element !== 'object' || element === null) continue;
        const item = (element as Record<string, unknown>).item;
        walk(
          typeof item === 'object' && item !== null ? item : element,
          depth + 1,
          from,
          listId,
          false,
        );
      }
      return;
    }
    found.push({ entity: toEntity(admitted, from, record), list, topLevel, root });
  };

  for (const value of blocks.values) walk(value, 0, 'json-ld', null, true);
  for (const item of microdataItems(index)) walk(item, 0, 'microdata', null, true);

  const listSizes = new Map<number, number>();
  const topLevelRoots = new Map<string, number>();
  for (const entry of found) {
    if (entry.list !== null) listSizes.set(entry.list, (listSizes.get(entry.list) ?? 0) + 1);
    if (entry.topLevel && entry.root !== 'ItemList') {
      topLevelRoots.set(entry.root, (topLevelRoots.get(entry.root) ?? 0) + 1);
    }
  }
  const shown = found.slice(0, MAX_STRUCTURED).map((entry) => entry.entity);
  return {
    entities: shown,
    found: found.length,
    types: [...new Set(shown.map((entity) => entity.type))],
    ignoredTypes: [...ignored].sort(),
    malformed: blocks.malformed,
    skippedBytes: blocks.skippedBytes,
    largestList: Math.max(0, ...listSizes.values()),
    topLevelSameRoot: Math.max(0, ...topLevelRoots.values()),
    mainEntities: found
      .filter(
        (entry) =>
          entry.topLevel &&
          entry.root !== 'ItemList' &&
          Object.keys(entry.entity.props).length >= 4,
      )
      .map((entry) => entry.entity),
  };
}

/** Characters of scalar text an entity carries (its shape mass). */
export function entityChars(entities: readonly StructuredEntity[]): number {
  let total = 0;
  for (const entity of entities) {
    for (const value of Object.values(entity.props)) total += String(value).length;
  }
  return total;
}

/**
 * Normalized `@type` names: the last segment of a vocabulary IRI or compact
 * name (`schema:Car` → `Car`).
 */
function typesOf(record: Record<string, unknown>): string[] {
  const raw = record['@type'];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().split(/[/:#]/u).filter(Boolean).pop() ?? '')
    .filter((value) => value.length > 0);
}

/** Flattens an entity's props under the bounds. */
function toEntity(
  type: string,
  from: StructuredEntity['from'],
  record: Record<string, unknown>,
): StructuredEntity {
  const props: Record<string, string | number | boolean> = {};
  let bytes = 2; // the enclosing braces
  let count = 0;
  const add = (key: string, value: string | number | boolean): void => {
    if (count >= MAX_PROPS) return;
    const bounded = typeof value === 'string' ? value.slice(0, PROP_STRING_MAX) : value;
    const cost = Buffer.byteLength(`${JSON.stringify(key)}:${JSON.stringify(bounded)},`, 'utf8');
    if (bytes + cost > ENTITY_BYTES_MAX) return;
    props[key] = bounded;
    bytes += cost;
    count += 1;
  };
  const flatten = (value: unknown, prefix: string, depth: number): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      if (prefix.length > 0) add(prefix, value);
      return;
    }
    if (depth >= FLATTEN_DEPTH || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      const scalars = value.filter(
        (item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
      );
      if (scalars.length === value.length) {
        if (scalars.length > 0) add(prefix, scalars.map(String).join(', '));
        return;
      }
      value.slice(0, ARRAY_OBJECTS_MAX).forEach((item, position) => {
        flatten(item, `${prefix}.${position}`, depth + 1);
      });
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith('@') && key !== '@type') continue;
      if (depth === 0 && (key === '@type' || key === 'itemListElement')) continue;
      const path = prefix.length === 0 ? key : `${prefix}.${key}`;
      if (key === '@type') {
        // A nested type is vocabulary, not a page URL: `Offer`, never its IRI.
        const names = typesOf({ '@type': nested });
        if (names.length > 0) add(path, names.join(', '));
        continue;
      }
      flatten(nested, path, depth + 1);
    }
  };
  flatten(record, '', 0);
  return { type, from, props };
}

/** A script element's text, read straight from its text children. */
function scriptText(node: PageNode): string {
  return (node.children ?? []).map((child) => child.data ?? '').join('');
}

/**
 * Microdata items as plain objects in JSON-LD form, so one walk and one
 * flattener serve both syntaxes. A top-level item is an `itemscope` with an
 * `itemtype` that is not itself another item's property.
 */
function microdataItems(index: PageIndex): Record<string, unknown>[] {
  const isItem = (node: PageNode): boolean => attrOf(node, 'itemscope') !== undefined;
  return index
    .select(
      (node) =>
        isItem(node) &&
        attrOf(node, 'itemtype') !== undefined &&
        !index.factsOf(node).hidden &&
        (attrOf(node, 'itemprop') === undefined || closest(node, isItem) === null),
    )
    .map((node) => microdataObject(index, node, 0));
}

function microdataObject(index: PageIndex, item: PageNode, depth: number): Record<string, unknown> {
  const isItem = (node: PageNode): boolean => attrOf(node, 'itemscope') !== undefined;
  const out: Record<string, unknown> = {};
  const type = attrOf(item, 'itemtype');
  if (type !== undefined) out['@type'] = type.trim().split(/\s+/u);
  if (depth >= STRUCTURED_DEPTH) return out;
  const properties = index.within(
    item,
    (node) => attrOf(node, 'itemprop') !== undefined && closest(node, isItem) === item,
  );
  for (const node of properties) {
    const value = isItem(node)
      ? microdataObject(index, node, depth + 1)
      : microdataValue(index, node);
    for (const name of (attrOf(node, 'itemprop') ?? '').trim().split(/\s+/u).filter(Boolean)) {
      const existing: unknown = out[name];
      const prior: readonly unknown[] = Array.isArray(existing)
        ? (existing as unknown[])
        : [existing];
      out[name] = existing === undefined ? value : [...prior, value];
    }
  }
  return out;
}

/** An `itemprop` value: `content`, `href`, `src`, `datetime`, then visible text. */
function microdataValue(index: PageIndex, node: PageNode): string {
  for (const attribute of ['content', 'href', 'src', 'datetime']) {
    const value = attrOf(node, attribute);
    if (value !== undefined) return cleanRun(value);
  }
  return index.textOf(node);
}
