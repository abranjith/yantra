import type { ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { classifyHref } from '../primitives/Link.js';
import { Link } from '../primitives/Link.js';

/**
 * SafeMarkdown (FEAT-066): renders untrusted Markdown (model text, page
 * excerpts, `report.md`) with no way to run code or reach the network.
 *
 * - Raw HTML is skipped (`skipHtml`), and there is no raw-HTML plugin.
 * - Links render only for absolute `http:`/`https:` URLs, as Drshya Links
 *   (`rel="noopener noreferrer"`, new tab); anything else is plain text.
 * - Images are never loaded: an image renders as its alt text, so
 *   page-derived Markdown cannot trigger a third-party request (plan §7).
 * - `[n]` and `[A<n>]` tokens become citation chips through `renderCitation`
 *   only when they resolve in the current citation context; otherwise they
 *   stay literal text.
 */

/** A citation token: a source number or an action id. */
export type CitationRef =
  | { readonly kind: 'source'; readonly n: number }
  | { readonly kind: 'action'; readonly id: string };

/** Resolves and renders citation tokens for one document. */
export interface CitationContext {
  /** True when the token names evidence this document has. */
  resolves(ref: CitationRef): boolean;
  /** The chip for a resolved token. */
  render(ref: CitationRef): ReactNode;
}

export interface SafeMarkdownProps {
  readonly children: string;
  readonly citations?: CitationContext;
  readonly className?: string;
}

const CITATION_TAG = 'yantra-cite';
const TOKEN = /\[(A[1-9]\d*|[1-9]\d*)\]/gu;

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/** Splits text nodes at citation tokens into citation nodes; skips links and code. */
function splitCitations(node: MdNode): void {
  if (node.children === undefined) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      const text = child.value;
      let last = 0;
      for (const match of text.matchAll(TOKEN)) {
        const index = match.index;
        if (index > last) next.push({ type: 'text', value: text.slice(last, index) });
        next.push({
          type: 'citation',
          children: [],
          data: {
            hName: CITATION_TAG,
            hProperties: { dataRef: match[1] },
            hChildren: [{ type: 'text', value: match[0] }],
          },
        });
        last = index + match[0].length;
      }
      if (last === 0) next.push(child);
      else if (last < text.length) next.push({ type: 'text', value: text.slice(last) });
      continue;
    }
    if (child.type !== 'link' && child.type !== 'linkReference') splitCitations(child);
    next.push(child);
  }
  node.children = next;
}

/** The remark plugin behind citation chips. */
export function remarkCitations() {
  return (tree: MdNode): void => {
    splitCitations(tree);
  };
}

/** Parses a token reference (`3` or `A2`). */
export function parseCitationRef(ref: string): CitationRef | null {
  if (/^A[1-9]\d*$/u.test(ref)) return { kind: 'action', id: ref };
  if (/^[1-9]\d*$/u.test(ref)) return { kind: 'source', n: Number(ref) };
  return null;
}

/** True for an href SafeMarkdown renders as a link: absolute http(s) only. */
export function isSafeExternalHref(href: string | undefined): href is string {
  return (
    typeof href === 'string' && /^https?:\/\//iu.test(href) && classifyHref(href) === 'external'
  );
}

function components(citations: CitationContext | undefined): Components {
  const map: Record<string, unknown> = {
    a: ({ href, children }: { href?: string; children?: ReactNode }) =>
      isSafeExternalHref(href) ? <Link href={href}>{children}</Link> : <span>{children}</span>,
    img: ({ alt }: { alt?: string }) =>
      alt === undefined || alt.length === 0 ? null : <span data-part="image-alt">{alt}</span>,
    [CITATION_TAG]: ({
      node,
      children,
    }: {
      node?: { properties?: Record<string, unknown> };
      children?: ReactNode;
    }) => {
      const raw = node?.properties?.dataRef;
      const ref = typeof raw === 'string' ? parseCitationRef(raw) : null;
      if (ref === null || citations?.resolves(ref) !== true) {
        return <>{children}</>;
      }
      return citations.render(ref);
    },
  };
  return map;
}

/** See the module comment. */
export function SafeMarkdown({ children, citations, className }: SafeMarkdownProps): ReactNode {
  return (
    <div className={className ?? 'safe-markdown flex flex-col gap-3 text-ink'}>
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkCitations]}
        components={components(citations)}
      >
        {children}
      </Markdown>
    </div>
  );
}
