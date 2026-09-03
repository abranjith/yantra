/// <reference lib="dom" />

/** One candidate element's raw signal, before ranking/capping. */
export interface RawInteractable {
  readonly role: string;
  readonly name: string | null;
  readonly kind: 'button' | 'link' | 'input' | 'select';
  readonly disabled: boolean;
  readonly top: number;
  readonly left: number;
  readonly group: string | null;
  readonly scope: 'dialog' | 'page';
  readonly value: string | null;
  readonly valuePresent: boolean;
  readonly checked: boolean | null;
  readonly expanded: boolean | null;
  readonly selected: boolean | null;
  readonly visible: boolean;
  /**
   * Position in the `elements` array returned by the **same** traversal.
   *
   * The name is the contract: nothing may index a list this record did not come
   * from. Its predecessor, `selectorIndex`, indexed a *different* query's
   * NodeList minted by a second traversal in the controller, and the two were
   * held in step only by a doc comment demanding two selector constants stay
   * byte-identical. A drift there did not fail loudly — it silently bound every
   * ref to the wrong element.
   */
  readonly elementIndex: number;
  /**
   * Whether the element's root node is the document or an open shadow root.
   *
   * **Internal, and deliberately never model-visible.** `browser-common.ts`
   * forwards `observation.interactables` to the model wholesale, so a field
   * that reached the projection would become a payload contract change and
   * would cost every observation bytes for a diagnostic.
   */
  readonly composedScope: 'document' | 'open-shadow';
  /** Open shadow boundaries crossed to reach the element; 0 in the light DOM. */
  readonly rootNodeDepth: number;
  /**
   * Whether this element held focus at scan time.
   *
   * Read from the element's **own** root, because `document.activeElement`
   * reports the shadow *host* for a control inside an open shadow root, and a
   * host is not the control the page is typing into.
   *
   * **Internal, and deliberately never model-visible** — like
   * {@link RawInteractable.composedScope}, a field that reached the projection
   * would cost every observation bytes for a diagnostic.
   */
  readonly focused: boolean;
  /**
   * The outermost visible dialog/overlay/listbox/menu/grid this element sits in.
   *
   * Named with the same `{ role, name }` shape the obstruction protocol uses,
   * so "the dialog that opened" and "the dialog that is covering this control"
   * name the same thing. `null` for an element in page scope — the same walk
   * that answers {@link RawInteractable.scope} answers this, so it costs no
   * extra traversal.
   *
   * **Internal, and deliberately never model-visible.**
   */
  readonly container: { readonly role: string; readonly name: string } | null;
}

/** Result of one composed-tree pass: records and, optionally, their elements. */
export interface InteractableScan {
  readonly records: RawInteractable[];
  /**
   * Every candidate element the walk reached, indexed by `elementIndex`.
   *
   * A **superset** of the described records: an element can match the
   * candidate selector and still carry a role the record projection has no
   * kind for (`tab`, `menuitem`, and a caller-supplied selector's own
   * additions). Those elements are still addressable, and a caller that
   * describes handles itself — the deterministic replay port does — needs
   * them. Records index into this array rather than the reverse, so the
   * correspondence holds whichever subset a caller wants.
   *
   * Empty unless `withElements` was requested: a DOM node cannot survive a
   * by-value `Page.evaluate` return, so the record-only callers ask for
   * records alone and the handle-minting callers use `evaluateHandle`.
   */
  readonly elements: Element[];
}

/**
 * Scans buttons, links, and form controls in page context, walking the
 * **composed** tree so controls inside *open* shadow roots are seen.
 *
 * A closed shadow root is not filtered — it is unrepresentable. The platform
 * returns `null` from `host.shadowRoot` for one, so there is no closed-root
 * branch to write and none to get wrong. Such a control is absent from
 * observation, which is the correct and deliberate outcome.
 *
 * One pass produces the records **and** the elements they describe, related by
 * `elementIndex`. That correspondence is structural rather than conventional,
 * which is the point: a second traversal cannot drift out of step with a list
 * it never produced.
 *
 * The scan reads only. It sets no attribute, injects no marker, and adds no
 * node — observation must never mutate page state.
 *
 * Accessible names come primarily from the injected locator engine; the local
 * computation is a deliberately smaller offline fallback for pages where
 * injection is absent. The complete implementation is nested in this function
 * because Puppeteer serializes only the function body when it is passed to
 * `Page.evaluate`. That is also why there is one function taking a flag rather
 * than two sharing a helper: a helper defined outside would not survive
 * serialization.
 */
export function scanInteractablesInPage(
  options: {
    readonly withElements?: boolean;
    readonly max?: number;
    /**
     * Membership override for a caller asking a different question.
     *
     * The deterministic replay port legitimately addresses a slightly wider
     * set than the agent observation does, and it describes the handles
     * itself. Sharing the **walk** while letting each caller keep its own
     * membership is what stops a third copy of the traversal appearing —
     * which is the drift this whole scan exists to remove.
     */
    readonly selector?: string;
  } = {},
): InteractableScan {
  const withElements = options.withElements === true;
  const max =
    typeof options.max === 'number' && Number.isFinite(options.max)
      ? Math.max(0, Math.floor(options.max))
      : Number.MAX_SAFE_INTEGER;
  const maxShadowDepth = 16;
  const kindByRole: Record<string, 'button' | 'link' | 'input' | 'select'> = {
    button: 'button',
    link: 'link',
    textbox: 'input',
    searchbox: 'input',
    checkbox: 'input',
    radio: 'input',
    combobox: 'select',
    listbox: 'select',
    // Autocomplete suggestions. Without this the real options of a destination
    // or date combobox were structurally invisible to every observation, so an
    // agent that filled such a field had nothing correct left to click — the
    // logged run clicked a marketing tile instead. Options exist only while a
    // dropdown is open, so scanning them adds no steady-state noise.
    option: 'select',
  };
  // Membership is unchanged from the flat-tree query this walk replaces. The
  // selector is applied per element with `matches` rather than as one
  // `querySelectorAll`, because only a per-element test can be carried across
  // a shadow boundary.
  const candidateSelector =
    options.selector ??
    'button, a[href], input, select, textarea, [role="button"], [role="link"], ' +
      '[role="checkbox"], [role="radio"], [role="combobox"], [role="tab"], [role="menuitem"], ' +
      '[role="option"], [data-yantra-widget-target]';
  const results: RawInteractable[] = [];
  const elements: Element[] = [];
  const accessibleApi = (
    globalThis as unknown as {
      __yantra?: {
        describeAccessible?(element: Element): { readonly name: string };
      };
    }
  ).__yantra;

  const seen = new Set<Element>();
  /** Per-scan memo for container identities; see `describeContainer`. */
  const containerIdentities = new Map<
    HTMLElement,
    { readonly role: string; readonly name: string }
  >();
  let collected = 0;
  // Explicit stack rather than recursion: a pathological composed tree must be
  // bounded by `max`, not by the JS call stack.
  const stack: { element: Element; depth: number }[] = [];
  const root = document.documentElement;
  if (root) stack.push({ element: root, depth: 0 });

  while (stack.length > 0 && collected < max) {
    const { element, depth } = stack.pop()!;
    // A slotted light-DOM element is reachable both through its host's shadow
    // tree and through its own light parent. Identity dedup is what keeps it
    // recorded exactly once.
    if (seen.has(element)) continue;
    seen.add(element);

    if (element instanceof HTMLElement) record(element, depth);

    // Light children are pushed first so the shadow tree — which is what the
    // page actually renders in their place — pops and is visited first.
    const lightChildren = element.children;
    for (let index = lightChildren.length - 1; index >= 0; index -= 1) {
      const child = lightChildren.item(index);
      if (child) stack.push({ element: child, depth });
    }
    // `shadowRoot` is null for a closed root: the page does not expose it, and
    // no piercing library or DOM tagging is used to get around that.
    const shadow = element.shadowRoot;
    if (shadow && depth < maxShadowDepth) {
      const shadowChildren = shadow.children;
      for (let index = shadowChildren.length - 1; index >= 0; index -= 1) {
        const child = shadowChildren.item(index);
        if (child) stack.push({ element: child, depth: depth + 1 });
      }
    }
  }

  return { records: results, elements };

  function record(element: HTMLElement, depth: number): void {
    if (!element.matches(candidateSelector)) return;
    // Collected before it is described: an addressable element the record
    // projection has no kind for is still addressable, and a caller that
    // describes handles itself must be able to reach it.
    const elementIndex = collected;
    collected += 1;
    if (withElements) elements.push(element);
    const role = computeRole(element);
    const kind = role === null ? undefined : kindByRole[role];
    if (role === null || kind === undefined) return;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const currentValue = computeValue(element);
    const enclosing = computeScope(element);
    results.push({
      role,
      name: computeName(element),
      kind,
      disabled:
        ('disabled' in element && Boolean((element as HTMLInputElement).disabled)) ||
        element.getAttribute('aria-disabled') === 'true',
      top: rect.top,
      left: rect.left,
      group: computeGroup(element),
      scope: enclosing.scope,
      container: enclosing.container,
      focused: rootOf(element).activeElement === element,
      value: currentValue.value,
      valuePresent: currentValue.valuePresent,
      checked: computeChecked(element),
      expanded: readAriaBoolean(element, 'aria-expanded'),
      selected: computeSelected(element),
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none',
      elementIndex,
      composedScope: depth > 0 ? 'open-shadow' : 'document',
      rootNodeDepth: depth,
    });
  }

  /**
   * The element's own root — its shadow root, or the document.
   *
   * Every id lookup goes through this rather than `document`, because ids are
   * scoped per shadow root: a shadow-hosted control labelled by an id that
   * exists only inside its own root is named correctly, and a same-valued id
   * in the document does not leak into it.
   */
  function rootOf(element: Element): DocumentOrShadowRoot & ParentNode & NonElementParentNode {
    const node = element.getRootNode();
    return node as unknown as DocumentOrShadowRoot & ParentNode & NonElementParentNode;
  }

  function textById(element: Element, ids: string): string {
    const scope = rootOf(element);
    return ids
      .trim()
      .split(/\s+/)
      .map((id) => scope.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
  }

  /**
   * The next element up the **composed** tree.
   *
   * A `parentElement` walk terminates at a shadow boundary, which would report
   * a shadow-hosted control as having no group and page scope even when its
   * host sits inside a labelled dialog.
   */
  function composedParent(node: Element): HTMLElement | null {
    const parent = node.parentElement;
    if (parent) return parent;
    const host = (node.getRootNode() as { host?: unknown }).host;
    return host instanceof HTMLElement ? host : null;
  }

  function computeRole(element: HTMLElement): string | null {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    if (element.hasAttribute('data-yantra-widget-target')) return 'button';
    const tag = element.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag !== 'input') return null;
    const type = (element as HTMLInputElement).type.toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
    return 'textbox';
  }

  /**
   * Offline mirror of the locator runtime's accname "name from content" step.
   * Kept in sync with `getAccessibleName` deliberately: a page that names its
   * controls through a labelling child would otherwise be readable only when
   * injection succeeded, and unreadable in exactly the same way as before when
   * it did not.
   */
  function nameFromContent(element: Element, depth = 0): string {
    if (depth > 16) return '';
    const parts: string[] = [];
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 3) {
        parts.push(child.nodeValue ?? '');
        continue;
      }
      if (child.nodeType !== 1) continue;
      const node = child as Element;
      if (node.getAttribute('aria-hidden') === 'true') continue;
      const declared =
        node.getAttribute('aria-label')?.trim() ?? node.getAttribute('alt')?.trim() ?? '';
      parts.push(declared || nameFromContent(node, depth + 1));
    }
    return parts.join('');
  }

  function computeName(element: HTMLElement): string | null {
    try {
      const engineName = accessibleApi?.describeAccessible?.(element).name.trim();
      if (engineName) return truncate(engineName);
    } catch {
      // The injected runtime is best-effort. A page mid-navigation or a
      // degraded test facade must still receive the local fallback below.
    }
    const ariaLabel = element.getAttribute('aria-label')?.trim();
    if (ariaLabel) return truncate(ariaLabel);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = textById(element, labelledBy);
      if (text) return truncate(text);
    }
    const id = element.id;
    if (id) {
      const label = rootOf(element).querySelector(`label[for="${escapeCss(id)}"]`)?.textContent;
      if (label?.trim()) return truncate(normalize(label));
    }
    const parentLabel = element.closest('label')?.textContent;
    if (parentLabel?.trim()) return truncate(normalize(parentLabel));
    // Options carry their label as text content, like buttons and links do, and
    // an unnamed option is unusable — name matching is the only way to pick one.
    if (
      element.matches(
        'button,a,[role="button"],[role="link"],[role="option"],[role="menuitem"],[role="tab"]',
      )
    ) {
      const text = nameFromContent(element);
      if (text) return truncate(normalize(text));
    }
    const fallback =
      element.getAttribute('placeholder')?.trim() ?? element.getAttribute('title')?.trim();
    return fallback ? truncate(fallback) : null;
  }

  /**
   * Return the nearest labelled container. An unlabelled matching ancestor is
   * skipped rather than treated as terminal: calendar cells commonly meet an
   * inner table before the outer month panel that actually names the group.
   */
  function computeGroup(element: HTMLElement): string | null {
    const groupSelector =
      '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], ' +
      '[role="grid"], [role="table"], [role="group"], [role="region"], ' +
      '[role="tabpanel"], table, [aria-label], [aria-labelledby]';
    let ancestor = composedParent(element);
    for (let depth = 0; ancestor && ancestor !== document.body && depth < 12; depth += 1) {
      if (ancestor.matches(groupSelector)) {
        const ariaLabel = ancestor.getAttribute('aria-label');
        if (ariaLabel?.trim()) return truncateGroup(normalize(ariaLabel));

        const labelledBy = ancestor.getAttribute('aria-labelledby');
        if (labelledBy) {
          const text = textById(ancestor, labelledBy);
          if (text.trim()) return truncateGroup(normalize(text));
        }

        if (ancestor instanceof HTMLTableElement) {
          const caption = ancestor.caption?.textContent;
          if (caption?.trim()) return truncateGroup(normalize(caption));
        }

        const heading = ancestor.querySelector<HTMLElement>(
          'h1,h2,h3,h4,h5,h6,[role="heading"]',
        )?.textContent;
        if (heading?.trim()) return truncateGroup(normalize(heading));

        let sibling = ancestor.previousElementSibling;
        while (sibling) {
          if (sibling.matches('h1,h2,h3,h4,h5,h6,[role="heading"]')) {
            const preceding = sibling.textContent;
            if (preceding?.trim()) return truncateGroup(normalize(preceding));
          }
          const nested = sibling.querySelector<HTMLElement>(
            'h1,h2,h3,h4,h5,h6,[role="heading"]',
          )?.textContent;
          if (nested?.trim()) return truncateGroup(normalize(nested));
          sibling = sibling.previousElementSibling;
        }
      }
      ancestor = composedParent(ancestor);
    }
    return null;
  }

  /**
   * The element's enclosing scope, and the container that defines it.
   *
   * Walks to the **outermost** matching visible ancestor rather than stopping
   * at the first, matching `overlay-dismiss.ts`'s ancestry rule and the
   * obstruction protocol's outermost-container selection: a control inside a
   * suggestion listbox inside a modal belongs to the *modal*, which is the
   * thing a person would say opened. `scope` is unchanged by this — any match
   * at any depth still means `'dialog'`.
   */
  function computeScope(element: HTMLElement): {
    readonly scope: 'dialog' | 'page';
    readonly container: { readonly role: string; readonly name: string } | null;
  } {
    const scopeSelector =
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], ' +
      '[role="listbox"], [role="menu"], [role="grid"]';
    let outermost: HTMLElement | null = null;
    let ancestor = composedParent(element);
    while (ancestor && ancestor !== document.body) {
      if (ancestor.matches(scopeSelector) && isVisibleContainer(ancestor)) outermost = ancestor;
      ancestor = composedParent(ancestor);
    }
    if (!outermost) return { scope: 'page', container: null };
    return { scope: 'dialog', container: describeContainer(outermost) };
  }

  /**
   * Name a container once per element, however many controls it holds.
   *
   * A modal with two hundred controls would otherwise recompute the same
   * accessible name two hundred times inside a loop that is already the
   * hottest part of the scan.
   */
  function describeContainer(element: HTMLElement): {
    readonly role: string;
    readonly name: string;
  } {
    const cached = containerIdentities.get(element);
    if (cached) return cached;
    const identity = { role: containerRole(element), name: computeName(element) ?? '' };
    containerIdentities.set(element, identity);
    return identity;
  }

  /**
   * A container's role, covering the two scope-selector shapes that carry none.
   *
   * `<dialog open>` and a bare `aria-modal="true"` wrapper are dialogs by
   * platform semantics without declaring a role attribute; everything else in
   * the selector declares its own.
   */
  function containerRole(element: HTMLElement): string {
    const explicit = element.getAttribute('role')?.trim();
    if (explicit) return explicit;
    if (element.tagName.toLowerCase() === 'dialog') return 'dialog';
    if (element.getAttribute('aria-modal') === 'true') return 'dialog';
    return '';
  }

  function isVisibleContainer(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    );
  }

  function computeValue(element: HTMLElement): {
    readonly value: string | null;
    readonly valuePresent: boolean;
  } {
    let raw: string | null = null;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      raw = element.value;
    } else if (element instanceof HTMLSelectElement) {
      const option = element.selectedOptions[0];
      raw = option ? option.label || option.text : '';
    } else if (element.matches('[contenteditable]')) {
      raw = element.textContent ?? '';
    }
    if (raw === null) return { value: null, valuePresent: false };

    const autocomplete = element.getAttribute('autocomplete') ?? '';
    const withheld =
      element.matches('input[type="password"]') ||
      /\b(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)\b/i.test(
        autocomplete,
      ) ||
      element.hasAttribute('data-yantra-secret');
    if (withheld) return { value: null, valuePresent: raw.length > 0 };

    const value = normalize(raw);
    return { value: value.length > 0 ? truncateValue(value) : null, valuePresent: false };
  }

  function computeChecked(element: HTMLElement): boolean | null {
    if (
      element instanceof HTMLInputElement &&
      (element.type.toLowerCase() === 'checkbox' || element.type.toLowerCase() === 'radio')
    ) {
      return element.checked;
    }
    return readAriaBoolean(element, 'aria-checked');
  }

  function computeSelected(element: HTMLElement): boolean | null {
    const selected = readAriaBoolean(element, 'aria-selected');
    if (selected !== null) return selected;
    const current = element.getAttribute('aria-current');
    return current !== null && current.toLowerCase() !== 'false' ? true : null;
  }

  function readAriaBoolean(element: HTMLElement, attribute: string): boolean | null {
    const value = element.getAttribute(attribute)?.toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
  }

  function normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }
  function truncate(text: string): string {
    return text.length > 200 ? text.slice(0, 200) : text;
  }
  function truncateGroup(text: string): string {
    return text.length > 80 ? text.slice(0, 80) : text;
  }
  function truncateValue(text: string): string {
    return text.length > 120 ? text.slice(0, 120) : text;
  }
  function escapeCss(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  }
}
