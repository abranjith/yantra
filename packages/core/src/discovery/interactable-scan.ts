/// <reference lib="dom" />

/** Options for the single serialized composed-tree scan. */
export interface ScanOptions {
  readonly withElements?: boolean;
  readonly max?: number;
  readonly elementKeys?: boolean;
  readonly challengeTokens?: readonly string[];
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
}

/** One candidate element's raw signal, before ranking/capping. */
export interface RawFieldEvidence {
  readonly explicit: string | null;
  readonly autocomplete: string | null;
  readonly maxLength: number | null;
  readonly pattern: string | null;
  readonly selectPlaceholder: string | null;
  readonly placeholder: string | null;
  readonly title: string | null;
  readonly structural: {
    readonly text: string;
    readonly source: 'row' | 'label-cell' | 'wrapper' | 'legend';
    readonly adjacent: boolean | null;
  } | null;
  readonly section: string | null;
  readonly htmlName: string | null;
  readonly htmlId: string | null;
  readonly inputType: string | null;
  readonly readOnly: boolean;
  readonly disabled: boolean;
  readonly required: boolean;
  readonly radioGroup: string | null;
  readonly checkboxSet: string | null;
  readonly humanVerification: boolean;
  readonly hiddenInput: boolean;
}

export interface RawInteractable {
  readonly elementKey: number | null;
  readonly field: RawFieldEvidence | null;
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
  readonly truncated: boolean;
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
export function scanInteractablesInPage(options: ScanOptions = {}): InteractableScan {
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
  const memoHost = window as unknown as Record<
    symbol,
    { keys: WeakMap<Element, number>; next: number }
  >;
  const memoSymbol = Symbol.for('yantra.elementKeys');
  const memo = options.elementKeys
    ? (memoHost[memoSymbol] ??= { keys: new WeakMap(), next: 1 })
    : null;
  const groupIndexes = new Map<Element, number>();
  function groupIndex(element: Element | null): number {
    if (!element) return -1;
    if (!groupIndexes.has(element)) groupIndexes.set(element, groupIndexes.size);
    return groupIndexes.get(element)!;
  }
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

  return { records: results, elements, truncated: stack.length > 0 };

  function record(element: HTMLElement, depth: number): void {
    if (!element.matches(candidateSelector)) return;
    if (element instanceof HTMLInputElement && element.type === 'hidden') return;
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
    const field = ['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio'].includes(
      role,
    )
      ? fieldEvidence(element)
      : null;
    if (memo && !memo.keys.has(element)) memo.keys.set(element, memo.next++);
    results.push({
      elementKey: memo?.keys.get(element) ?? null,
      field,
      role,
      name: computeName(element),
      kind,
      disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
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

  function fieldEvidence(element: HTMLElement): RawFieldEvidence {
    const input = element instanceof HTMLInputElement ? element : null;
    const owner = (element as HTMLInputElement).form ?? null;
    const name = element.getAttribute('name');
    const fieldset = element.closest('fieldset');
    const radioRoot = element.closest('[role="radiogroup"]');
    let humanVerification = false;
    let ancestor: HTMLElement | null = element;
    for (let depth = 0; ancestor && depth < 20; depth += 1) {
      const markers = [
        ancestor.id,
        ancestor.className,
        ancestor.getAttribute('name') ?? '',
        ...ancestor.getAttributeNames(),
      ]
        .join(' ')
        .toLowerCase();
      if (options.challengeTokens?.some((token) => markers.includes(token)))
        humanVerification = true;
      if (ancestor === owner) break;
      ancestor = composedParent(ancestor);
    }
    const checkboxScope = fieldset ?? owner ?? rootOf(element);
    const checkboxes = Array.from(
      checkboxScope.querySelectorAll('input[type="checkbox"], [role="checkbox"]'),
    );
    const checkboxSet =
      checkboxes.filter(
        (item) => fieldset !== null || (name !== null && item.getAttribute('name') === name),
      ).length >= 2
        ? fieldset
          ? `fieldset:${groupIndex(fieldset)}`
          : `${groupIndex(owner)}:${name}`
        : null;
    return {
      explicit: explicitLabel(element),
      autocomplete: autocompleteToken(element),
      maxLength:
        'maxLength' in element && (element as HTMLInputElement).maxLength > 0
          ? (element as HTMLInputElement).maxLength
          : null,
      pattern: boundedText(element.getAttribute('pattern'), 40, false),
      selectPlaceholder:
        element instanceof HTMLSelectElement && element.options[0]?.value === ''
          ? boundedText(element.options[0].text, 80)
          : null,
      placeholder: boundedText(element.getAttribute('placeholder'), 80),
      title: boundedText(element.getAttribute('title'), 80),
      structural: structuralLabel(element),
      section: fieldSection(element, owner),
      htmlName: developerHint(name),
      htmlId: developerHint(element.id),
      inputType: input
        ? input.type.toLowerCase()
        : element.matches('textarea,select')
          ? element.tagName.toLowerCase()
          : null,
      readOnly:
        ('readOnly' in element && Boolean((element as HTMLInputElement).readOnly)) ||
        element.getAttribute('aria-readonly') === 'true',
      disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
      required:
        ('required' in element && Boolean((element as HTMLInputElement).required)) ||
        element.getAttribute('aria-required') === 'true',
      radioGroup:
        input?.type === 'radio' && name
          ? `${groupIndex(owner)}:${name}`
          : radioRoot
            ? `aria:${groupIndex(radioRoot)}`
            : null,
      checkboxSet: element.matches('input[type="checkbox"], [role="checkbox"]')
        ? checkboxSet
        : null,
      humanVerification,
      hiddenInput: input?.type === 'hidden',
    };
  }

  function boundedText(value: string | null | undefined, limit: number, cut = true): string | null {
    const text = normalize(value ?? '');
    return text ? (text.length > limit ? (cut ? text.slice(0, limit) : null) : text) : null;
  }

  function developerHint(value: string | null): string | null {
    return (value?.match(/\p{L}/gu)?.length ?? 0) >= 2 ? boundedText(value, 40) : null;
  }

  function explicitLabel(element: HTMLElement): string | null {
    const ids = element.getAttribute('aria-labelledby');
    const byIds = ids ? textById(element, ids) : '';
    if (byIds) return boundedText(byIds, 200);
    const aria = boundedText(element.getAttribute('aria-label'), 200);
    if (aria) return aria;
    const labels = 'labels' in element ? (element as HTMLInputElement).labels : null;
    if (labels?.length)
      return boundedText(Array.from(labels, (label) => labelText(label, element)).join(' '), 200);
    return null;
  }

  function autocompleteToken(element: HTMLElement): string | null {
    const fields = new Set(
      'name honorific-prefix given-name additional-name family-name honorific-suffix nickname username new-password current-password one-time-code organization-title organization street-address address-line1 address-line2 address-line3 address-level4 address-level3 address-level2 address-level1 country country-name postal-code cc-name cc-given-name cc-additional-name cc-family-name cc-number cc-exp cc-exp-month cc-exp-year cc-csc cc-type transaction-currency transaction-amount language bday bday-day bday-month bday-year sex url photo tel tel-country-code tel-national tel-area-code tel-local tel-local-prefix tel-local-suffix tel-extension email impp'.split(
        ' ',
      ),
    );
    return (
      element
        .getAttribute('autocomplete')
        ?.toLowerCase()
        .split(/\s+/u)
        .find((token) => fields.has(token)) ?? null
    );
  }

  function fillableMembers(root: Element): Element[] {
    return Array.from(
      root.querySelectorAll(
        'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]), textarea, select, [role="textbox"], [role="searchbox"], [role="combobox"], [role="listbox"], [role="radio"], [role="checkbox"]',
      ),
    );
  }

  /** Text belonging to this bounded structure, excluding controls and diagnostics. */
  function labelText(root: Element, control: Element): string {
    const excludedIds = new Set(
      [
        control.getAttribute('aria-describedby') ?? '',
        control.getAttribute('aria-errormessage') ?? '',
      ]
        .join(' ')
        .split(/\s+/u)
        .filter(Boolean),
    );
    const parts: string[] = [];
    let visited = 0;
    function visit(node: Node, depth: number): void {
      if (++visited > 200 || depth > 8) return;
      if (node.nodeType === 3) {
        parts.push(node.nodeValue ?? '');
        return;
      }
      if (!(node instanceof Element)) return;
      if (
        node === control ||
        node.matches(
          'input,textarea,select,option,button,script,style,[role="textbox"],[role="searchbox"],[role="combobox"],[role="listbox"],[role="radio"],[role="checkbox"],[role="option"],[role="alert"],[role="status"],[aria-live]',
        ) ||
        excludedIds.has(node.id)
      )
        return;
      for (const child of node.childNodes) visit(child, depth + 1);
    }
    // The root may itself be a label/legend, but never take a control subtree.
    for (const child of root.childNodes) visit(child, 0);
    return visited > 200 ? '' : normalize(parts.join(' '));
  }

  function singleControlOrSet(root: Element, control: Element): boolean {
    const members = fillableMembers(root);
    if (members.length === 1) return members[0] === control;
    if (members.length < 2) return false;
    const role = computeRole(control as HTMLElement);
    if (role !== 'radio' && role !== 'checkbox') return false;
    if (!members.every((member) => computeRole(member as HTMLElement) === role)) return false;
    const name = control.getAttribute('name');
    return (
      (role === 'checkbox' && root.matches('fieldset')) ||
      Boolean(name && members.every((member) => member.getAttribute('name') === name))
    );
  }

  function structuralLabel(element: HTMLElement): RawFieldEvidence['structural'] {
    function evidence(
      root: Element,
      source: NonNullable<RawFieldEvidence['structural']>['source'],
    ): RawFieldEvidence['structural'] {
      const text = boundedText(labelText(root, element), 80, false);
      if (!text) return null;
      const labelBox = root.getBoundingClientRect();
      const controlBox = element.getBoundingClientRect();
      const adjacent =
        labelBox.width <= 0 ||
        labelBox.height <= 0 ||
        controlBox.width <= 0 ||
        controlBox.height <= 0
          ? null
          : labelBox.left <= controlBox.left &&
            labelBox.top <= controlBox.top &&
            Math.max(controlBox.left - labelBox.right, controlBox.top - labelBox.bottom) <= 160;
      return { text, source, adjacent };
    }
    const cell = element.closest('td,th,[role="cell"],[role="gridcell"]');
    if (cell) {
      let previous = cell.previousElementSibling;
      for (let n = 0; previous && n < 20; n += 1, previous = previous.previousElementSibling) {
        // Crossing another control would bind the preceding pair's label.
        if (fillableMembers(previous).length > 0) break;
        const found = evidence(previous, 'label-cell');
        if (found) return found;
      }
    }
    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && depth < 3; depth += 1, ancestor = ancestor.parentElement) {
      if (ancestor.matches('body,html,form')) break;
      if (!singleControlOrSet(ancestor, element)) continue;
      const source = ancestor.matches('tr,[role="row"]') ? 'row' : 'wrapper';
      // A legend is handled explicitly so its source survives diagnostics.
      if (ancestor.matches('fieldset')) continue;
      const found = evidence(ancestor, source);
      if (found) return found;
    }
    const fieldset = element.closest('fieldset');
    if (
      fieldset &&
      singleControlOrSet(fieldset, element) &&
      element.matches('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]')
    ) {
      const legend = fieldset.querySelector(':scope > legend');
      if (legend) return evidence(legend, 'legend');
    }
    return null;
  }

  function fieldSection(element: HTMLElement, owner: HTMLFormElement | null): string | null {
    const legend = element.closest('fieldset')?.querySelector(':scope > legend');
    if (legend) return boundedText(labelText(legend, element), 60);
    if (!owner) return null;
    let current: Element | null = element;
    for (
      let level = 0;
      current && current !== owner && level < 8;
      level += 1, current = current.parentElement
    ) {
      let sibling = current.previousElementSibling;
      for (let n = 0; sibling && n < 20; n += 1, sibling = sibling.previousElementSibling) {
        if (sibling.matches('h1,h2,h3,h4,h5,h6,[role="heading"]'))
          return boundedText(labelText(sibling, element), 60);
      }
    }
    return null;
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
