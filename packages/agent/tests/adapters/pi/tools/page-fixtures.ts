/**
 * Generic page patterns for the FEAT-051 agent suites. Each is one nameable
 * structural pattern; the provenance of each pattern is the run and gap named
 * in its comment, and no body names a real site.
 */

/** Listing cards with a linked title and seller, plain-text price, and distance (G2, run 20260925T130634Z). */
export const LISTING_SELLERS = [
  'Lakeside Motors',
  'Prairie Auto Group',
  'Cedar Hollow Motors',
  'Brightwater Auto Mall',
  'Northgate Motor Co.',
  'Fairview Auto Plaza',
] as const;

/** One results page of six cards, a facet sidebar, and pagination. */
export function listingHtml(): string {
  const cards = LISTING_SELLERS.map(
    (seller, n) =>
      `<li><h3><a href="/vehicle/itm-0${n + 1}">New 2026 Teyra Summit ${n + 1}</a></h3>` +
      `<div><span>${50_000 + n * 250}</span> <span>MSRP $${51_000 + n * 250}</span></div>` +
      `<p><a href="/dealer/${n + 1}">${seller}</a></p><p>${(n * 3.1 + 2).toFixed(1)} mi away</p>` +
      `<a href="/vehicle/itm-0${n + 1}">View details</a></li>`,
  ).join('');
  return (
    '<!doctype html><html lang="en"><head><title>Teyra for sale</title></head><body>' +
    '<header><nav aria-label="Site"><a href="/new/results">Shop new</a></nav></header>' +
    '<aside aria-label="Refine"><h2>Drivetrain</h2><ul>' +
    '<li><a href="/new/results?drivetrain=AWD">AWD (9)</a></li>' +
    '<li><a href="/new/results?drivetrain=FWD">FWD (3)</a></li></ul></aside>' +
    `<main><h1>Teyra for sale near you</h1><ol>${cards}</ol>` +
    '<nav aria-label="Pagination"><span aria-current="page">1</span>' +
    '<a href="/new/results?page=2">2</a><a rel="next" href="/new/results?page=2">Next</a></nav>' +
    '</main></body></html>'
  );
}

/** A detail page whose attributes live in a definition list (G3 target trace). */
export function detailHtml(exterior: string, interior: string, seller: string): string {
  return (
    '<!doctype html><html lang="en"><head><title>New 2026 Teyra Summit</title></head><body>' +
    '<main><article><h1>New 2026 Teyra Summit</h1><p>$50,265</p>' +
    `<p>Offered by <a href="/dealer/1">${seller}</a>, 27.0 mi away.</p>` +
    '<dl>' +
    `<dt>Exterior color</dt><dd>${exterior}</dd><dt>Interior color</dt><dd>${interior}</dd>` +
    '<dt>Drivetrain</dt><dd>AWD</dd><dt>Condition</dt><dd>New</dd><dt>Year</dt><dd>2026</dd>' +
    '<dt>Trim</dt><dd>Summit</dd></dl>' +
    '<p>The listed price includes dealer fees; taxes, title, and registration are additional. ' +
    'Availability is confirmed by the seller at the time of purchase.</p>' +
    '</article></main></body></html>'
  );
}

/** Long-form prose (the article path must stay byte-identical). */
export function articleHtml(): string {
  const paragraphs = [
    'A home backup battery should cover at least one full day of essential load, and two days is a safer target where outages run long.',
    'Essential load means refrigeration, lighting, communications, and any medical equipment; heating and cooling are usually excluded because they dominate consumption.',
    'A typical household with a ten kilowatt-hour daily essential load therefore needs between ten and twenty kilowatt-hours of usable capacity.',
    'Usable capacity is lower than the nameplate figure, because most batteries reserve a margin at the bottom of their charge range to protect the cells.',
  ];
  return (
    '<!doctype html><html lang="en"><head><title>Sizing a backup battery</title>' +
    '<meta property="article:published_time" content="2026-05-10T12:00:00Z"></head><body>' +
    `<main><article><h1>Sizing a backup battery</h1>${paragraphs.map((p) => `<p>${p}</p>`).join('')}` +
    '</article></main></body></html>'
  );
}

/** A hub: section links and no prose of its own. */
export function hubHtml(): string {
  return (
    '<!doctype html><html lang="en"><head><title>Departments</title></head><body><main><ul>' +
    '<li><a href="/departments/garden">Garden</a></li><li><a href="/departments/kitchen">Kitchen</a></li>' +
    '<li><a href="/departments/lighting">Lighting</a></li></ul></main></body></html>'
  );
}

/** A page with nothing readable at all. */
export function emptyHtml(): string {
  return '<!doctype html><html lang="en"><head><title>Loading</title></head><body><div></div></body></html>';
}

/** Two tables; the answer is in the second (TODO line 214). */
export function multiTableHtml(): string {
  const table = (caption: string, rows: readonly (readonly string[])[]): string =>
    `<table><caption>${caption}</caption><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody>` +
    rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('') +
    '</tbody></table>';
  return (
    '<!doctype html><html lang="en"><head><title>Specifications</title></head><body><main>' +
    '<h1>Specifications</h1>' +
    table('Showroom hours', [
      ['Weekdays', '9:00', '19:00'],
      ['Saturday', '9:00', '17:00'],
      ['Sunday', 'Closed', 'Closed'],
    ]) +
    table('Towing by trim', [
      ['Base', 'FWD', '1,500 lb'],
      ['Ridge', 'AWD', '3,500 lb'],
      ['Summit', 'AWD', '4,500 lb'],
    ]) +
    '</main></body></html>'
  );
}
