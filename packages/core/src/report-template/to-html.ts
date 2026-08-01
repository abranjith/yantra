/** Inert, self-contained HTML rendering for runtime-rendered template reports. */

import type { TemplatedReport } from '@yantra/protocol';

import { escapeHtml, hardenedMarkdown, inertDocument } from '../brief/html-shell.js';

/**
 * Render a templated report through the same escape-before-parse shell as Briefs.
 *
 * Raw HTML is escaped, non-http(s) links collapse to text, Markdown images are
 * inert alt text, and the returned document contains no scripts or remote loads.
 *
 * @param report Validated report document.
 * @returns Complete `document.html` bytes with a trailing newline.
 */
export function templatedReportToHtml(report: TemplatedReport): string {
  const body = (hardenedMarkdown.parse(escapeHtml(report.rendered_md)) as string).trim();
  return inertDocument(report.title, body);
}
