/**
 * A read-only structural view of the extractor's one cheerio parse (FEAT-051).
 *
 * Page analysis must add zero HTML parses and must never mutate the parse it
 * shares with Readability's pre-clean, so every analysis module reads the same
 * htmlparser2 tree through this view. One iterative pre-order walk builds a
 * {@link PageIndex} of per-element facts — document order, hidden-ness,
 * landmark membership, visible text length, link count — that the record,
 * link, table, and field modules consult instead of re-walking the tree.
 *
 * Nodes are typed structurally, as in `html-to-text.ts`: cheerio does not
 * re-export its node types and `domhandler` is not resolvable under pnpm's
 * isolated `node_modules`.
 *
 * Structural only: this module, like every module under `extraction/page/`,
 * never reads a `class` or `id` attribute, names a host, or branches on a URL
 * literal (enforced by `structural-only.spec.ts`).
 */

import type { CheerioAPI } from 'cheerio';

import {
  HTML_BLOCK_TAGS,
  HTML_ROW_TAGS,
  HTML_SKIP_TAGS,
  normalizeExtractedText,
} from '../html-to-text.js';

/** Minimal structural view of an htmlparser2 node. */
export interface PageNode {
  readonly type: string;
  readonly name?: string;
  readonly data?: string;
  readonly attribs?: Readonly<Record<string, string>>;
  readonly children?: readonly PageNode[];
  readonly parent?: PageNode | null;
}

/** htmlparser2 gives `<script>` and `<style>` their own node types. */
const ELEMENT_TYPES: ReadonlySet<string> = new Set(['tag', 'script', 'style']);

/** Elements that are always landmarks (ARIA navigation / complementary). */
const LANDMARK_TAGS: ReadonlySet<string> = new Set(['nav', 'aside']);

/**
 * `header`/`footer` are banner/contentinfo landmarks only when they are not
 * scoped to a sectioning element (the HTML-AAM mapping); a card's own
 * `<header>` is not page chrome.
 */
const SCOPED_LANDMARK_TAGS: ReadonlySet<string> = new Set(['header', 'footer']);
const SECTIONING_TAGS: ReadonlySet<string> = new Set([
  'article',
  'aside',
  'main',
  'nav',
  'section',
]);

/** Explicit landmark roles counted as page chrome. */
const LANDMARK_ROLES: ReadonlySet<string> = new Set([
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
]);

/** Facts about one element, computed once per analysis. */
export interface NodeFacts {
  /** Pre-order position among all elements. */
  readonly order: number;
  /** The element or an ancestor is `hidden`, `aria-hidden="true"`, or non-content (script, style, …). */
  readonly hidden: boolean;
  /** The element or an ancestor is a navigation/banner/contentinfo/complementary landmark. */
  readonly landmark: boolean;
  /** Visible characters in the subtree (whitespace runs counted once). */
  readonly textLength: number;
  /** `a[href]` elements in the subtree, the element itself included. */
  readonly linkCount: number;
}

/** Whether a node is an element. */
export function isElement(node: PageNode): boolean {
  return ELEMENT_TYPES.has(node.type) && typeof node.name === 'string';
}

/** The lowercase tag name, or `''` for a non-element. */
export function tagOf(node: PageNode): string {
  return isElement(node) ? (node.name ?? '').toLowerCase() : '';
}

/** One attribute's value. */
export function attrOf(node: PageNode, name: string): string | undefined {
  return node.attribs?.[name];
}

/** The element children of a node, in order. */
export function elementChildren(node: PageNode): PageNode[] {
  return (node.children ?? []).filter(isElement);
}

/** Whether `ancestor` contains `node` (a node does not contain itself). */
export function contains(ancestor: PageNode, node: PageNode): boolean {
  for (let current = node.parent ?? null; current !== null; current = current.parent ?? null) {
    if (current === ancestor) return true;
  }
  return false;
}

/** The nearest ancestor (excluding the node) matching a predicate. */
export function closest(
  node: PageNode,
  predicate: (candidate: PageNode) => boolean,
): PageNode | null {
  for (let current = node.parent ?? null; current !== null; current = current.parent ?? null) {
    if (isElement(current) && predicate(current)) return current;
  }
  return null;
}

/**
 * Cleans one inline text run through the shared extraction normalization
 * (NBSP, zero-widths, pictographs, footnote markers, adjacent repeats), so a
 * record segment is cleaned exactly as article text is.
 */
export function cleanRun(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length === 0 ? '' : normalizeExtractedText(flat).replace(/\s+/gu, ' ').trim();
}

/** Options for {@link PageIndex.runsOf}. */
export interface RunOptions {
  /** Subtrees to skip entirely (their text belongs to another part, e.g. a field). */
  readonly exclude?: (node: PageNode) => boolean;
  /** Skip text inside landmarks (page-level reads). */
  readonly skipLandmarks?: boolean;
}

/**
 * Per-analysis index over the shared parse. Construction walks the tree once;
 * every later query is a map lookup or a walk of one subtree.
 */
export class PageIndex {
  /** Every element in document pre-order. */
  public readonly elements: readonly PageNode[];
  private readonly facts = new Map<PageNode, NodeFacts>();
  private readonly textMemo = new Map<PageNode, string>();
  private readonly bodyNode: PageNode;

  public constructor($: CheerioAPI) {
    // Cheerio's own node types are not exported; the structural view is
    // sufficient for a read-only walk.
    const root = $.root().toArray()[0] as unknown as PageNode;
    const elements: PageNode[] = [];
    const ownText = new Map<PageNode, number>();
    const stack: PageNode[] = [...(root.children ?? [])].reverse();
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      if (!isElement(node)) {
        if (node.type === 'text' && node.parent && isElement(node.parent)) {
          const parent = node.parent;
          ownText.set(parent, (ownText.get(parent) ?? 0) + collapsedLength(node.data ?? ''));
        }
        continue;
      }
      const parentFacts = node.parent ? this.facts.get(node.parent) : undefined;
      const tag = tagOf(node);
      this.facts.set(node, {
        order: elements.length,
        hidden: (parentFacts?.hidden ?? false) || isHiddenElement(node, tag),
        landmark: (parentFacts?.landmark ?? false) || isLandmarkElement(node, tag),
        textLength: 0,
        linkCount: 0,
      });
      elements.push(node);
      const children = node.children ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) stack.push(child);
      }
    }
    // Post-order aggregation: in reverse pre-order every child precedes its parent.
    const textTotals = new Map<PageNode, number>();
    const linkTotals = new Map<PageNode, number>();
    for (let index = elements.length - 1; index >= 0; index -= 1) {
      const node = elements[index];
      if (node === undefined) continue;
      const own = this.facts.get(node);
      if (own === undefined) continue;
      const text = own.hidden ? 0 : (textTotals.get(node) ?? 0) + (ownText.get(node) ?? 0);
      const links =
        (linkTotals.get(node) ?? 0) + (tagOf(node) === 'a' && attrOf(node, 'href') ? 1 : 0);
      this.facts.set(node, { ...own, textLength: text, linkCount: own.hidden ? 0 : links });
      const parent = node.parent;
      if (parent && isElement(parent)) {
        textTotals.set(parent, (textTotals.get(parent) ?? 0) + text);
        linkTotals.set(parent, (linkTotals.get(parent) ?? 0) + (own.hidden ? 0 : links));
      }
    }
    this.elements = elements;
    this.bodyNode = elements.find((node) => tagOf(node) === 'body') ?? root;
  }

  /** The `<body>` element (the document root when there is none). */
  public body(): PageNode {
    return this.bodyNode;
  }

  /** Facts for an element (zeroed defaults for a node outside the index). */
  public factsOf(node: PageNode): NodeFacts {
    return (
      this.facts.get(node) ?? {
        order: -1,
        hidden: false,
        landmark: false,
        textLength: 0,
        linkCount: 0,
      }
    );
  }

  /** Elements matching a predicate, in document order. */
  public select(predicate: (node: PageNode) => boolean): PageNode[] {
    return this.elements.filter(predicate);
  }

  /** Elements under `ancestor` (excluded) matching a predicate, in document order. */
  public within(ancestor: PageNode, predicate: (node: PageNode) => boolean): PageNode[] {
    const out: PageNode[] = [];
    const stack: PageNode[] = [...elementChildren(ancestor)].reverse();
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      if (predicate(node)) out.push(node);
      const children = elementChildren(node);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) stack.push(child);
      }
    }
    return out;
  }

  /** The subtree's visible text on one line, cleaned (memoized). */
  public textOf(node: PageNode): string {
    const memo = this.textMemo.get(node);
    if (memo !== undefined) return memo;
    const text = cleanRun(this.runsOf(node).join(' '));
    this.textMemo.set(node, text);
    return text;
  }

  /**
   * The subtree's visible block-level text runs, in document order: inline
   * text (anchor text included) joins into one run, and every block, row, or
   * cell boundary and `<br>` ends it. Hidden and non-content subtrees are
   * skipped.
   */
  public runsOf(node: PageNode, options: RunOptions = {}): string[] {
    const runs: string[] = [];
    let current = '';
    const flush = (): void => {
      const cleaned = cleanRun(current);
      if (cleaned.length > 0) runs.push(cleaned);
      current = '';
    };
    interface Frame {
      readonly node: PageNode;
      readonly exit: boolean;
    }
    const stack: Frame[] = [{ node, exit: false }];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame === undefined) break;
      const { node: target } = frame;
      if (frame.exit) {
        flush();
        continue;
      }
      if (!isElement(target)) {
        if (target.type === 'text') current += target.data ?? '';
        continue;
      }
      const facts = this.factsOf(target);
      if (facts.hidden) continue;
      if (options.skipLandmarks === true && facts.landmark) continue;
      if (target !== node && options.exclude?.(target) === true) continue;
      const tag = tagOf(target);
      if (tag === 'br') {
        flush();
        continue;
      }
      const isBlock = HTML_BLOCK_TAGS.has(tag) || HTML_ROW_TAGS.has(tag) || tag === 'li';
      if (isBlock) {
        flush();
        stack.push({ node: target, exit: true });
      }
      const children = target.children ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) stack.push({ node: child, exit: false });
      }
    }
    flush();
    return runs;
  }
}

function isHiddenElement(node: PageNode, tag: string): boolean {
  if (HTML_SKIP_TAGS.has(tag) || node.type === 'script' || node.type === 'style') return true;
  if (attrOf(node, 'hidden') !== undefined) return true;
  return (attrOf(node, 'aria-hidden') ?? '').trim().toLowerCase() === 'true';
}

function isLandmarkElement(node: PageNode, tag: string): boolean {
  if (LANDMARK_TAGS.has(tag)) return true;
  const role = (attrOf(node, 'role') ?? '').trim().toLowerCase();
  if (role.length > 0 && role.split(/\s+/u).some((entry) => LANDMARK_ROLES.has(entry))) {
    return true;
  }
  if (!SCOPED_LANDMARK_TAGS.has(tag)) return false;
  return closest(node, (ancestor) => SECTIONING_TAGS.has(tagOf(ancestor))) === null;
}

/** Visible characters of one text node: whitespace runs collapse, formatting-only whitespace counts zero. */
function collapsedLength(text: string): number {
  return text.replace(/\s+/gu, ' ').trim().length;
}
