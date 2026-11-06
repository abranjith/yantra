/**
 * Gallery entries: one per primitive plus token and icon sheets.
 *
 * Every entry renders deterministically (fixed data, no clocks), because the
 * harness screenshots it against a visual baseline.
 */

import { useState, type ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import { ICON_NAMES, type IconName } from '../icons/registry.js';
import { Button } from '../primitives/Button.js';
import { Checkbox } from '../primitives/Checkbox.js';
import { ComboBox } from '../primitives/ComboBox.js';
import { Dialog, DialogTrigger } from '../primitives/Dialog.js';
import { Disclosure, DisclosurePanel, DisclosureTrigger } from '../primitives/Disclosure.js';
import type { PrimitiveFamily } from '../primitives/families.js';
import { Link } from '../primitives/Link.js';
import {
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
  MenuTrigger,
  SubmenuTrigger,
} from '../primitives/Menu.js';
import { NumberField } from '../primitives/NumberField.js';
import { Popover, PopoverDialog, PopoverTrigger } from '../primitives/Popover.js';
import { Select, type ListOption } from '../primitives/Select.js';
import { Switch } from '../primitives/Switch.js';
import { Table, type TableColumn } from '../primitives/Table.js';
import { Tab, TabList, TabPanel, Tabs } from '../primitives/Tabs.js';
import { TextField } from '../primitives/TextField.js';
import { createToastQueue, ToastProvider } from '../primitives/Toast.js';
import { Tooltip, TooltipTrigger } from '../primitives/Tooltip.js';
import { DRSHYA_TOKENS, pairingRatio } from '../tokens/emit.js';
import { CONTRAST_PAIRINGS, type ContrastPairing } from '../tokens/pairings.js';
import { THEMES } from '../tokens/palette.js';
import { SEMANTIC_COLOR_NAMES } from '../tokens/semantic.js';

import { BG_CLASS, TEXT_CLASS } from './classes.js';
import { fixtureRuns, type FixtureOutcome, type FixtureRun } from './fixtures.js';

declare global {
  interface Window {
    /** How many times the large-table entry asked for more rows (harness probe). */
    __drshyaLoadMoreCount?: number;
  }
}

export interface GalleryEntry {
  /** Kebab-case and unique; used in the URL and in baseline file names. */
  readonly id: string;
  readonly title: string;
  /** The primitive family this entry demonstrates, or `null` for sheets. */
  readonly primitive: PrimitiveFamily | null;
  readonly render: () => ReactNode;
  /** Whether the harness walks focus through this entry. */
  readonly interactive: boolean;
  /**
   * Whether the entry renders React Aria overlays (toasts, popovers, dialogs),
   * which portal into `document.body`. The harness then screenshots the full
   * page and scopes axe and the focus walk to the whole document.
   */
  readonly overlays?: true;
}

function ratioLabel(pairing: ContrastPairing): string {
  return THEMES.map((theme) => {
    const ratio = pairingRatio(DRSHYA_TOKENS, pairing, theme);
    return `${theme} ${ratio === null ? 'n/a' : ratio.toFixed(2)}`;
  }).join(' · ');
}

/** The class that paints a pairing's background; glass pairings sit on real glass. */
function backgroundClass(pairing: ContrastPairing): string {
  return pairing.bg === 'glass' ? 'glass' : BG_CLASS[pairing.bg];
}

function ColorSheet(): ReactNode {
  return (
    <ul className="grid grid-cols-4 gap-4">
      {SEMANTIC_COLOR_NAMES.map((color) => (
        <li key={color} className="flex flex-col gap-1">
          <div
            aria-hidden="true"
            className={`h-10 rounded-chip border border-rule-strong ${BG_CLASS[color]}`}
          />
          <span className="type-engine text-ink-2">{color}</span>
        </li>
      ))}
    </ul>
  );
}

function PairingSample({ pairing }: { readonly pairing: ContrastPairing }): ReactNode {
  const label = `${pairing.fg} on ${pairing.bg}`;
  if (pairing.kind === 'text') {
    return (
      <li
        className={`flex items-baseline justify-between gap-4 px-3 py-2 ${backgroundClass(pairing)}`}
      >
        <span className={TEXT_CLASS[pairing.fg]}>{label}</span>
        <span className={`type-engine ${TEXT_CLASS[pairing.fg]}`}>{ratioLabel(pairing)}</span>
      </li>
    );
  }
  // Non-text pairings are shown as the graphic they govern, labelled in ink.
  return (
    <li className={`flex items-center justify-between gap-4 px-3 py-2 ${backgroundClass(pairing)}`}>
      <span className="flex items-center gap-2 text-ink">
        <span
          aria-hidden="true"
          className={`inline-block size-4 rounded-full ${BG_CLASS[pairing.fg]}`}
        />
        {label} (graphic)
      </span>
      <span className="type-engine text-ink">{ratioLabel(pairing)}</span>
    </li>
  );
}

function PairingSheet(): ReactNode {
  return (
    <ul className="flex flex-col border border-rule">
      {CONTRAST_PAIRINGS.map((pairing) => (
        <PairingSample key={`${pairing.fg}/${pairing.bg}`} pairing={pairing} />
      ))}
    </ul>
  );
}

/** Static class names per type step, so Tailwind generates each one. */
const TYPE_SAMPLES = [
  { name: 'micro', className: 'text-micro' },
  { name: 'caption', className: 'text-caption' },
  { name: 'body', className: 'text-body' },
  { name: 'lead', className: 'text-lead' },
  { name: 'title', className: 'text-title' },
  { name: 'headline', className: 'text-headline' },
] as const;

const RADIUS_SAMPLES = [
  { name: 'chip', className: 'rounded-chip' },
  { name: 'control', className: 'rounded-control' },
  { name: 'frame', className: 'rounded-frame' },
  { name: 'full', className: 'rounded-full' },
] as const;

function TypeShapeMotionSheet(): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <span className="type-label text-ink-2">Mission</span>
        <span className="type-display text-ink">00:42</span>
        <p className="type-body text-ink">
          Compare the return policies of three outdoor-gear stores and cite each one.
        </p>
        <p className="type-agent" data-voice="agent">
          understood: three stores, the return window and restocking fee, each with a citation.
        </p>
        <p className="type-engine text-ink" data-voice="engine">
          browser_fill_form #07 A6
        </p>
      </div>
      <ul className="flex flex-col gap-1">
        {TYPE_SAMPLES.map((sample) => (
          <li key={sample.name} className={`text-ink ${sample.className}`}>
            {sample.name}: Evidence before eloquence
          </li>
        ))}
      </ul>
      <ul className="flex items-end gap-4">
        {RADIUS_SAMPLES.map((sample) => (
          <li key={sample.name} className="flex flex-col items-center gap-1">
            <span
              aria-hidden="true"
              className={`block size-12 border border-rule-strong bg-sunken ${sample.className}`}
            />
            <span className="type-engine text-ink-2">{sample.name}</span>
          </li>
        ))}
        <li className="flex flex-col items-center gap-1">
          {/* A banned default: the class compiles to nothing (spec S1). */}
          <span
            aria-hidden="true"
            data-banned-radius
            className="block size-12 rounded-2xl border border-rule-strong bg-sunken"
          />
          <span className="type-engine text-ink-2">2xl (none)</span>
        </li>
      </ul>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          data-motion-loop
          className="gallery-motion-loop block size-3 rounded-full bg-accent"
        />
        <span className="text-ink-2">A loop that reduced motion stops</span>
      </div>
    </div>
  );
}

/** Every registry name with its label, at 16 and 20 px. */
function IconSheet(): ReactNode {
  return (
    <ul className="grid grid-cols-3 gap-x-6 gap-y-2">
      {ICON_NAMES.map((name) => (
        <li key={name} className="flex items-center gap-3 text-ink">
          <Icon name={name} size={16} />
          <Icon name={name} size={20} />
          <span className="type-engine text-ink-2">{name}</span>
        </li>
      ))}
    </ul>
  );
}

const BUTTON_VARIANTS = ['primary', 'secondary', 'quiet'] as const;
const BUTTON_SIZES = ['sm', 'md'] as const;

function ButtonSheet(): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      {BUTTON_VARIANTS.map((variant) => (
        <div key={variant} className="flex flex-wrap items-center gap-3">
          <span className="type-engine w-24 text-ink-2">{variant}</span>
          {BUTTON_SIZES.map((size) => (
            <Button key={size} variant={variant} size={size}>
              Run {size}
            </Button>
          ))}
          <Button variant={variant} icon="action.retry">
            Retry
          </Button>
          <Button variant={variant} icon="action.copy" aria-label="Copy command" />
          <Button variant={variant} isPending>
            Saving
          </Button>
          <Button variant={variant} isDisabled>
            Disabled
          </Button>
        </div>
      ))}
    </div>
  );
}

function LinkSheet(): ReactNode {
  return (
    <ul className="flex flex-col gap-2 text-ink">
      <li>
        Internal: <Link href="/runs/42">Run 42</Link>
      </li>
      <li>
        External: <Link href="https://example.com/returns">Return policy</Link>
      </li>
      <li>
        Unsafe (rendered as text): <Link href="javascript:alert(1)">Not a link</Link>
      </li>
    </ul>
  );
}

function TabsSheet(): ReactNode {
  return (
    <Tabs defaultSelectedKey="timeline">
      <TabList aria-label="Run views">
        <Tab id="timeline">Timeline</Tab>
        <Tab id="evidence">Evidence</Tab>
        <Tab id="audit">Audit</Tab>
        <Tab id="usage" isDisabled>
          Usage
        </Tab>
      </TabList>
      <TabPanel id="timeline">
        <p className="text-ink">Twelve tool calls, two steers, no escalations.</p>
      </TabPanel>
      <TabPanel id="evidence">
        <p className="text-ink">Four cited sources.</p>
      </TabPanel>
      <TabPanel id="audit">
        <p className="text-ink">Nothing left the page that the policy withheld.</p>
      </TabPanel>
      <TabPanel id="usage">
        <p className="text-ink">Usage is not available for this run.</p>
      </TabPanel>
    </Tabs>
  );
}

function TooltipSheet(): ReactNode {
  return (
    <div className="flex min-h-24 items-start gap-4 pt-12">
      <TooltipTrigger isOpen>
        <Button variant="quiet" icon="action.copy" aria-label="Copy command" />
        <Tooltip placement="top">Copy the CLI command</Tooltip>
      </TooltipTrigger>
      <TooltipTrigger>
        <Button variant="secondary" icon="action.stop">
          Stop
        </Button>
        <Tooltip>Stops the run after the current step</Tooltip>
      </TooltipTrigger>
    </div>
  );
}

function DisclosureSheet(): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      <Disclosure defaultExpanded>
        <DisclosureTrigger headingLevel={3}>Constraints</DisclosureTrigger>
        <DisclosurePanel>
          <p>Return window at least 30 days; restocking fee stated.</p>
        </DisclosurePanel>
      </Disclosure>
      <Disclosure>
        <DisclosureTrigger headingLevel={3}>Also consulted</DisclosureTrigger>
        <DisclosurePanel>
          <p>Two pages that did not state a policy.</p>
        </DisclosurePanel>
      </Disclosure>
    </div>
  );
}

/** One toast per tone plus one with an action, without timers (deterministic). */
function ToastSheet(): ReactNode {
  const [queue] = useState(() => {
    const created = createToastQueue({ maxVisibleToasts: 6, autoDismiss: false });
    created.add({ tone: 'info', title: 'Run saved as a workflow' });
    created.add({
      tone: 'fulfilled',
      title: 'Run fulfilled',
      description: 'Three of three requirements met, each cited.',
    });
    created.add({
      tone: 'partial',
      title: 'Partially fulfilled',
      description: 'One source unverified.',
    });
    created.add({
      tone: 'failed',
      title: 'Run failed',
      description: 'The site blocked automation.',
    });
    created.add({
      tone: 'needs-you',
      title: 'Confirmation needed',
      description: 'Submitting the form spends money.',
      action: { label: 'Review', onAction: () => undefined },
    });
    return created;
  });
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ink-2">Toasts announce politely and never take focus.</p>
      <ToastProvider queue={queue} />
    </div>
  );
}

const OUTCOME_CELL = {
  fulfilled: {
    icon: 'outcome.fulfilled',
    className: 'text-signal-fulfilled-ink',
    label: 'Fulfilled',
  },
  partial: { icon: 'outcome.partial', className: 'text-signal-partial-ink', label: 'Partial' },
  failed: { icon: 'outcome.failed', className: 'text-signal-failed-ink', label: 'Failed' },
  aborted: { icon: 'outcome.aborted', className: 'text-ink-2', label: 'Aborted' },
} as const satisfies Record<
  FixtureOutcome,
  { readonly icon: IconName; readonly className: string; readonly label: string }
>;

const RUN_COLUMNS: readonly TableColumn<FixtureRun>[] = [
  { id: 'id', header: 'Run', cell: (run) => run.id, voice: 'engine', width: 140 },
  { id: 'goal', header: 'Goal', cell: (run) => run.goal, isRowHeader: true, width: '3fr' },
  { id: 'mode', header: 'Mode', cell: (run) => run.mode, width: 110 },
  {
    id: 'outcome',
    header: 'Outcome',
    width: 140,
    cell: (run) => {
      const outcome = OUTCOME_CELL[run.outcome];
      return (
        <span className={`inline-flex items-center gap-2 ${outcome.className}`}>
          <Icon name={outcome.icon} size={16} />
          {outcome.label}
        </span>
      );
    },
  },
  {
    id: 'duration',
    header: 'Duration',
    cell: (run) => run.duration,
    voice: 'engine',
    align: 'end',
    width: 110,
  },
];

const SMALL_RUNS = fixtureRuns(25);

function TableSheet(): ReactNode {
  return (
    <Table
      aria-label="Recent runs"
      columns={RUN_COLUMNS}
      rows={SMALL_RUNS}
      getRowKey={(run) => run.id}
      emptyState="No runs yet"
      height="32rem"
    />
  );
}

function LargeTableSheet(): ReactNode {
  const [rows] = useState(() => fixtureRuns(10_000));
  return (
    <Table
      aria-label="All runs"
      columns={RUN_COLUMNS}
      rows={rows}
      getRowKey={(run) => run.id}
      emptyState="No runs yet"
      loadState="idle"
      onLoadMore={() => {
        window.__drshyaLoadMoreCount = (window.__drshyaLoadMoreCount ?? 0) + 1;
      }}
      height="32rem"
    />
  );
}

function TextFieldSheet(): ReactNode {
  return (
    <div className="grid max-w-3xl grid-cols-2 gap-6">
      <TextField
        label="Goal"
        description="What the run should accomplish."
        defaultValue="Compare return policies"
      />
      <TextField
        label="Start URL"
        voice="engine"
        isRequired
        defaultValue="https://example.com/returns"
      />
      <TextField
        label="Profile name"
        isInvalid
        defaultValue="work profile!"
        errorMessage="Use letters, digits and dashes only."
      />
      <TextField label="Run ID" isDisabled voice="engine" defaultValue="run-00042" />
      <TextField
        label="Notes"
        multiline
        description="Kept with the run, never sent to the model."
        defaultValue="Prefer stores with free returns."
      />
    </div>
  );
}

function NumberFieldSheet(): ReactNode {
  return (
    <div className="grid max-w-3xl grid-cols-2 gap-6">
      <NumberField label="Max hops" defaultValue={12} minValue={1} maxValue={50} />
      <NumberField
        label="Budget (USD)"
        isRequired
        defaultValue={2.5}
        step={0.5}
        minValue={0}
        formatOptions={{ style: 'currency', currency: 'USD' }}
      />
      <NumberField
        label="Sources"
        isInvalid
        defaultValue={0}
        errorMessage="At least one source is needed."
      />
      <NumberField label="Captures" isDisabled defaultValue={3} />
    </div>
  );
}

function CheckboxSheet(): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <Checkbox>Save as a workflow</Checkbox>
      <Checkbox defaultSelected>Cite every claim</Checkbox>
      <Checkbox isIndeterminate>Some sources selected</Checkbox>
      <Checkbox isDisabled>Allow uploads (not available)</Checkbox>
      <Checkbox isRequired isInvalid>
        I reviewed the consent terms (required)
      </Checkbox>
    </div>
  );
}

function SwitchSheet(): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <Switch>Headless browser</Switch>
      <Switch defaultSelected>Solid surfaces</Switch>
      <Switch isDisabled>Scheduled runs (daemon offline)</Switch>
      <Switch isDisabled defaultSelected>
        Audit log (always on)
      </Switch>
    </div>
  );
}

const PROVIDERS: readonly ListOption[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'ollama', label: 'Ollama (local)' },
  { id: 'none', label: 'No model (deterministic only)' },
  { id: 'other', label: 'Other provider', isDisabled: true },
];

const SEARCH_PROVIDERS: readonly ListOption[] = [
  { id: 'brave', label: 'Brave Search' },
  { id: 'searxng', label: 'SearXNG' },
  { id: 'duckduckgo', label: 'DuckDuckGo' },
  { id: 'fixture', label: 'Fixture search (tests)' },
];

/** Overlays open over the busy stripe backdrop, so glass is judged at its worst. */
function OverlayStage({ children }: { readonly children: ReactNode }): ReactNode {
  return <div className="gallery-backdrop-stripes min-h-96 p-6">{children}</div>;
}

function PopoverSheet(): ReactNode {
  return (
    <OverlayStage>
      <PopoverTrigger defaultOpen>
        <Button variant="secondary" icon="glyph.provenance">
          Provenance
        </Button>
        <Popover placement="bottom start">
          <PopoverDialog aria-label="How this URL was found">
            <p className="font-semibold text-ink">Attested by a search result</p>
            <p className="text-ink-2">goal → search → page → link</p>
            <Button size="sm" variant="quiet" icon="action.copy">
              Copy URL
            </Button>
          </PopoverDialog>
        </Popover>
      </PopoverTrigger>
    </OverlayStage>
  );
}

function SelectSheet(): ReactNode {
  return (
    <OverlayStage>
      <div className="max-w-xs rounded-control bg-surface p-4">
        <Select
          label="Model provider"
          options={PROVIDERS}
          defaultSelectedKey="anthropic"
          defaultOpen
        />
      </div>
    </OverlayStage>
  );
}

function ComboBoxSheet(): ReactNode {
  return (
    <OverlayStage>
      <div className="max-w-xs rounded-control bg-surface p-4">
        <ComboBox
          label="Search provider"
          options={SEARCH_PROVIDERS}
          description="Type to filter."
          placeholder="Choose a provider"
        />
      </div>
    </OverlayStage>
  );
}

function DialogSheet(): ReactNode {
  return (
    <DialogTrigger defaultOpen>
      <Button variant="secondary">Rename workflow</Button>
      <Dialog title="Rename workflow">
        {({ close }) => (
          <>
            <TextField label="Workflow name" defaultValue="compare-returns" voice="engine" />
            <div className="flex justify-end gap-2">
              <Button variant="quiet" onPress={close}>
                Cancel
              </Button>
              <Button variant="primary" onPress={close}>
                Rename
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </DialogTrigger>
  );
}

function AlertDialogSheet(): ReactNode {
  return (
    <DialogTrigger defaultOpen>
      <Button variant="secondary">Delete run</Button>
      <Dialog title="Delete this run?" role="alertdialog">
        {({ close }) => (
          <>
            <p className="text-ink-2">
              The run directory, its captures and its Brief are removed. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onPress={close}>
                Keep run
              </Button>
              <Button variant="primary" icon="outcome.failed" onPress={close}>
                Delete run
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </DialogTrigger>
  );
}

function MenuSheet(): ReactNode {
  return (
    <OverlayStage>
      <MenuTrigger defaultOpen>
        <Button variant="secondary" icon="nav.chevronDown">
          Run actions
        </Button>
        <Menu aria-label="Run actions">
          <MenuSection title="Run">
            <MenuItem id="resume" icon="action.retry">
              Resume
            </MenuItem>
            <MenuItem id="copy" icon="action.copy">
              Copy CLI command
            </MenuItem>
            <SubmenuTrigger>
              <MenuItem id="export" icon="glyph.capture">
                Export
              </MenuItem>
              <Menu aria-label="Export formats" placement="end top">
                <MenuItem id="md">Markdown</MenuItem>
                <MenuItem id="json">JSON</MenuItem>
              </Menu>
            </SubmenuTrigger>
            <MenuItem id="schedule" icon="status.info" isDisabled>
              Schedule (daemon offline)
            </MenuItem>
          </MenuSection>
          <MenuSeparator />
          <MenuSection title="Danger">
            <MenuItem id="delete" tone="destructive" icon="outcome.failed">
              Delete run
            </MenuItem>
          </MenuSection>
        </Menu>
      </MenuTrigger>
    </OverlayStage>
  );
}

const GLASS_BACKDROPS = [
  { id: 'black', label: 'Over black', className: 'gallery-backdrop-black' },
  { id: 'white', label: 'Over white', className: 'gallery-backdrop-white' },
  { id: 'stripes', label: 'Over stripes', className: 'gallery-backdrop-stripes' },
] as const;

/**
 * A glass panel over the two analytic extremes and a busy pattern. The lower
 * right of each panel stays empty: the harness samples the tint there, over a
 * 64 px window that holds exactly one period of the noise tile.
 */
function GlassSheet(): ReactNode {
  return (
    <div className="grid grid-cols-3 gap-4">
      {GLASS_BACKDROPS.map((backdrop) => (
        <div
          key={backdrop.id}
          data-glass-backdrop={backdrop.id}
          className={`p-10 ${backdrop.className}`}
        >
          <div data-glass-panel className="glass flex h-56 flex-col gap-2 rounded-frame p-4">
            <p className="text-ink">{backdrop.label}: ink</p>
            <p className="text-ink-2">Secondary ink on glass</p>
            <span className="flex items-center gap-2 text-ink-2">
              <span
                aria-hidden="true"
                className="inline-block size-3 rounded-full bg-accent outline-2 outline-offset-2 outline-accent"
              />
              Ion as a graphic only
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The gallery's entries, in display order. */
export const GALLERY_ENTRIES: readonly GalleryEntry[] = [
  {
    id: 'tokens-colors',
    title: 'Semantic colors',
    primitive: null,
    render: () => <ColorSheet />,
    interactive: false,
  },
  {
    id: 'tokens-pairings',
    title: 'Contrast pairings',
    primitive: null,
    render: () => <PairingSheet />,
    interactive: false,
  },
  {
    id: 'surfaces-glass',
    title: 'Glass and Solid surfaces',
    primitive: null,
    render: () => <GlassSheet />,
    interactive: false,
  },
  {
    id: 'tokens-type-shape-motion',
    title: 'Type, shape and motion',
    primitive: null,
    render: () => <TypeShapeMotionSheet />,
    interactive: false,
  },
  {
    id: 'icons',
    title: 'Icons',
    primitive: null,
    render: () => <IconSheet />,
    interactive: false,
  },
  {
    id: 'button',
    title: 'Button',
    primitive: 'Button',
    render: () => <ButtonSheet />,
    interactive: true,
  },
  {
    id: 'link',
    title: 'Link',
    primitive: 'Link',
    render: () => <LinkSheet />,
    interactive: true,
  },
  {
    id: 'tabs',
    title: 'Tabs',
    primitive: 'Tabs',
    render: () => <TabsSheet />,
    interactive: true,
  },
  {
    id: 'tooltip',
    title: 'Tooltip',
    primitive: 'Tooltip',
    render: () => <TooltipSheet />,
    interactive: true,
  },
  {
    id: 'disclosure',
    title: 'Disclosure',
    primitive: 'Disclosure',
    render: () => <DisclosureSheet />,
    interactive: true,
  },
  {
    id: 'toast',
    title: 'Toast',
    primitive: 'Toast',
    render: () => <ToastSheet />,
    interactive: true,
    overlays: true,
  },
  {
    id: 'table',
    title: 'Table',
    primitive: 'Table',
    render: () => <TableSheet />,
    interactive: true,
  },
  {
    id: 'text-field',
    title: 'TextField',
    primitive: 'TextField',
    render: () => <TextFieldSheet />,
    interactive: true,
  },
  {
    id: 'number-field',
    title: 'NumberField',
    primitive: 'NumberField',
    render: () => <NumberFieldSheet />,
    interactive: true,
  },
  {
    id: 'checkbox',
    title: 'Checkbox',
    primitive: 'Checkbox',
    render: () => <CheckboxSheet />,
    interactive: true,
  },
  {
    id: 'switch',
    title: 'Switch',
    primitive: 'Switch',
    render: () => <SwitchSheet />,
    interactive: true,
  },
  {
    id: 'popover',
    title: 'Popover',
    primitive: 'Popover',
    render: () => <PopoverSheet />,
    interactive: true,
    overlays: true,
  },
  {
    id: 'select',
    title: 'Select',
    primitive: 'Select',
    render: () => <SelectSheet />,
    interactive: true,
    overlays: true,
  },
  {
    id: 'combo-box',
    title: 'ComboBox',
    primitive: 'ComboBox',
    render: () => <ComboBoxSheet />,
    interactive: true,
    overlays: true,
  },
  {
    id: 'dialog',
    title: 'Dialog',
    primitive: 'Dialog',
    render: () => <DialogSheet />,
    interactive: true,
    overlays: true,
  },
  {
    id: 'alert-dialog',
    title: 'AlertDialog',
    primitive: null,
    render: () => <AlertDialogSheet />,
    interactive: true,
    overlays: true,
  },
  {
    id: 'menu',
    title: 'Menu',
    primitive: 'Menu',
    render: () => <MenuSheet />,
    interactive: true,
    overlays: true,
  },
  {
    id: 'table-large',
    title: 'Table, 10,000 rows',
    primitive: null,
    render: () => <LargeTableSheet />,
    interactive: false,
  },
];
