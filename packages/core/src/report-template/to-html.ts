/** Inert, self-contained HTML rendering for runtime-rendered template reports. */

import type { TemplatedReport } from '@yantra/protocol';

import {
  escapeForMarkdown,
  escapeHtml,
  hardenedMarkdown,
  inertDocument,
} from '../brief/html-shell.js';

/**
 * Render a templated report through the same escape-before-parse shell as Briefs.
 *
 * Raw HTML is escaped, non-http(s) links collapse to text, Markdown images are
 * inert alt text, and the returned document contains no scripts or remote loads.
 *
 * A template body is author-written and need not open with a heading, so the
 * report title is promoted to an `<h1>` when the rendered Markdown supplies
 * none — otherwise the page would carry a title only in the browser tab.
 *
 * @param report Validated report document.
 * @returns Complete `document.html` bytes with a trailing newline.
 */
export function templatedReportToHtml(report: TemplatedReport): string {
  const body = (hardenedMarkdown.parse(escapeForMarkdown(report.rendered_md)) as string).trim();
  const titled = /<h1[\s>]/u.test(body) ? body : `<h1>${escapeHtml(report.title)}</h1>\n${body}`;
  return inertDocument(report.title, titled);
}
